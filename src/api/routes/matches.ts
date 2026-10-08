import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMatchListener, subscribeToMatch } from "../../infrastructure/matchNotifier.js";
import { requireAuthenticatedPlayer } from "../auth.js";
import { requireIdempotencyKey } from "../idempotencyHeader.js";
import { createMatchSchema, joinMatchSchema } from "../schemas.js";
import { createMatch, joinMatch, resignMatch, listPendingInvitations } from "../../application/matchService.js";
import { getMatchViewForPlayer } from "../../application/handQueryService.js";

/** Por debajo del timeout de inactividad habitual de proxies (30–60 s). */
export const LONG_POLL_MAX_MS = 25_000;
const matchViewQuerySchema = z.object({ since: z.coerce.number().int().nonnegative().optional() });

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/invitations", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const invitations = await listPendingInvitations(playerId);
    return reply.code(200).send(invitations);
  });

  app.post("/v1/matches", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = createMatchSchema.parse(request.body);

    const result = await createMatch({ creatorId: playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });

  app.post("/v1/matches/:matchId/join", async (request, reply) => {
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
  app.get("/v1/matches/:matchId", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const { matchId } = request.params as { matchId: string };
    const { since } = matchViewQuerySchema.parse(request.query);
    if (since === undefined) {
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

    const live = view.status === "IN_PROGRESS" || view.status === "WAITING_FOR_OPPONENT";
    if (!live || view.stateVersion > since) {
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
    try {
      await wait.changed;
    } finally {
      clearTimeout(expiryTimer);
      reply.raw.off("close", onClose);
    }
    if (clientGone) return reply; // nadie espera la respuesta: no gastar una lectura
    return reply.code(200).send(await getMatchViewForPlayer(matchId, playerId));
  });

  app.post("/v1/matches/:matchId/resign", async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };

    const result = await resignMatch({ matchId, playerId, idempotencyKey });
    return reply.code(result.status).send(result.body);
  });
}
