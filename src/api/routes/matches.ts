import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMatchListener, subscribeToMatch } from "../../infrastructure/matchNotifier.js";
import { requireAuthenticatedPlayer } from "../auth.js";
import { requireIdempotencyKey } from "../idempotencyHeader.js";
import { createMatchSchema, joinMatchSchema } from "../schemas.js";
import {
  createMatch,
  joinMatch,
  resignMatch,
  requestRematch,
  listPendingInvitations,
  listActiveMatches,
} from "../../application/matchService.js";
import { getMatchViewForPlayer } from "../../application/handQueryService.js";
import type { PlayerLimits } from "../rateLimits.js";

/** Por debajo del timeout de inactividad habitual de proxies (30–60 s). */
export const LONG_POLL_MAX_MS = 25_000;
/**
 * Esperas abiertas a la vez (AUD-06): por jugador en una misma partida, y por jugador en total (el
 * cliente muestra hasta 4 mesas, una espera cada una). Pasado el tope la petición se responde al
 * instante, sin esperar; si el cliente insiste, lo frena el límite de lecturas por partida. Antes un
 * solo token abría miles de esperas y, al despertar todas juntas, degradaba la latencia de todos.
 */
export const MAX_WAITS_PER_MATCH = 3;
export const MAX_WAITS_PER_PLAYER = 16;
const matchViewQuerySchema = z.object({ since: z.coerce.number().int().nonnegative().optional() });

/** Contador de esperas abiertas por clave (en memoria, por instancia). */
class WaitCounter {
  private readonly open = new Map<string, number>();
  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
  add(key: string, delta: 1 | -1): void {
    const next = this.count(key) + delta;
    if (next <= 0) this.open.delete(key);
    else this.open.set(key, next);
  }
}

export async function matchRoutes(app: FastifyInstance, { limits }: { limits: PlayerLimits }): Promise<void> {
  const waits = new WaitCounter();

  app.get("/v1/invitations", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const invitations = await listPendingInvitations(playerId);
    return reply.code(200).send(invitations);
  });

  /** Tus partidas sin terminar (en curso o esperando rival): el lobby las lista para volver a ellas. */
  app.get("/v1/matches", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    return reply.code(200).send(await listActiveMatches(playerId));
  });

  app.post("/v1/matches", { preHandler: limits.createMatch }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = createMatchSchema.parse(request.body);

    const result = await createMatch({ creatorId: playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });

  app.post("/v1/matches/:matchId/join", { preHandler: limits.matchCommand }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };
    const body = joinMatchSchema.parse(request.body);

    const result = await joinMatch({ matchId, playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });

  /**
   * Sin `since`: lectura inmediata. Con `since=<stateVersion>`: long-poll — responde en cuanto la
   * partida pase de esa versión, cuando vence el turno en curso (para que el timeout se resuelva) o
   * a los LONG_POLL_MAX_MS, lo que ocurra primero. Reemplaza el polling de 1.5 s del cliente.
   */
  app.get("/v1/matches/:matchId", { preHandler: limits.matchRead }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const { matchId } = request.params as { matchId: string };
    const { since } = matchViewQuerySchema.parse(request.query);
    if (since === undefined) {
      return reply.code(200).send(await getMatchViewForPlayer(matchId, playerId));
    }

    const perMatch = `${playerId}|${matchId}`;
    if (waits.count(perMatch) >= MAX_WAITS_PER_MATCH || waits.count(playerId) >= MAX_WAITS_PER_PLAYER) {
      return reply.code(200).send(await getMatchViewForPlayer(matchId, playerId));
    }

    await ensureMatchListener();
    // Suscribirse ANTES de leer: un cambio entre la lectura y la espera no se pierde.
    const wait = subscribeToMatch(matchId, LONG_POLL_MAX_MS);
    let view;
    try {
      view = await getMatchViewForPlayer(matchId, playerId);
    } catch (error) {
      wait.cancel();
      throw error;
    }

    // Una partida terminada también espera: así el rival ve al instante una oferta de revancha.
    const live = view.status !== "CANCELLED";
    if (!live || view.stateVersion > since) {
      wait.cancel();
      return reply.code(200).send(view);
    }
    // Se vuelve a mirar el tope: la lectura de arriba es asíncrona y otras esperas pudieron abrirse.
    if (waits.count(perMatch) >= MAX_WAITS_PER_MATCH || waits.count(playerId) >= MAX_WAITS_PER_PLAYER) {
      wait.cancel();
      return reply.code(200).send(view);
    }

    const untilTurnExpires = view.turn ? Date.parse(view.turn.expiresAt) - Date.now() + 50 : LONG_POLL_MAX_MS;
    const expiryTimer = setTimeout(wait.cancel, Math.max(0, untilTurnExpires));
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      wait.cancel();
    };
    reply.raw.once("close", onClose);
    waits.add(perMatch, 1);
    waits.add(playerId, 1);
    try {
      await wait.changed;
    } finally {
      waits.add(perMatch, -1);
      waits.add(playerId, -1);
      clearTimeout(expiryTimer);
      reply.raw.off("close", onClose);
    }
    if (clientGone) return reply; // nadie espera la respuesta: no gastar una lectura
    return reply.code(200).send(await getMatchViewForPlayer(matchId, playerId));
  });

  /** Revancha con las mismas reglas: el primero la crea (201), el segundo la acepta (200). */
  app.post("/v1/matches/:matchId/rematch", { preHandler: limits.matchCommand }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };
    const result = await requestRematch({ matchId, playerId, idempotencyKey });
    return reply.code(result.status).send(result.body);
  });

  app.post("/v1/matches/:matchId/resign", { preHandler: limits.matchCommand }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };

    const result = await resignMatch({ matchId, playerId, idempotencyKey });
    return reply.code(result.status).send(result.body);
  });
}
