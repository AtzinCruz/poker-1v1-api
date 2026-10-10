import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { DomainError } from "../domain/errors.js";
import { playerIdForRateLimit } from "./auth.js";

/*
 * Límites de tasa (§8 429 RATE_LIMITED, §8.1 "rate limiting por usuario y match"). El global por IP
 * (server.ts) frena a un cliente anónimo; los de aquí se SUMAN a él por cuenta, por jugador y por
 * partida (AUD-02, AUD-12), así que cambiar de IP no reinicia el cupo de una cuenta ni de una mesa.
 * Son en memoria, por instancia, igual que el global: con varias réplicas hace falta un store compartido.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Error 429 con `retryAfterMs` (§8: "Esperar retryAfterMs"), AUD-09. El manejador agrega Retry-After. */
export function rateLimitedError(retryAfterMs: number): DomainError {
  return new DomainError("RATE_LIMITED", "Demasiadas solicitudes; espera antes de reintentar", {
    retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
  });
}

interface LimitOptions {
  max: number;
  timeWindow: number;
  /** Clave del cupo; null = este límite no aplica a la petición (p. ej. cuerpo sin displayName). */
  key: (request: FastifyRequest) => string | null;
}

/**
 * Un límite propio como función: el plugin solo aplica UN límite por petición (marca la petición al
 * aplicar el global), así que los adicionales usan `createRateLimit`, que no la marca.
 */
function createLimit(app: FastifyInstance, options: LimitOptions): (request: FastifyRequest) => Promise<void> {
  const limiter = app.createRateLimit({
    max: options.max,
    timeWindow: options.timeWindow,
    keyGenerator: (request) => options.key(request) ?? "",
  });
  return async (request) => {
    if (options.key(request) === null) return;
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) throw rateLimitedError(result.ttl);
  };
}

function preHandler(check: (request: FastifyRequest) => Promise<void>): preHandlerAsyncHookHandler {
  return async (request) => check(request);
}

const playerKey = (request: FastifyRequest): string => {
  const playerId = playerIdForRateLimit(request);
  return playerId ? `player:${playerId}` : `ip:${request.ip}`;
};

const matchKey = (request: FastifyRequest): string =>
  `${playerKey(request)}|match:${(request.params as { matchId?: string }).matchId ?? "-"}`;

/**
 * Los límites por usuario y por partida que usan las rutas. Se crean UNA vez por servidor (server.ts)
 * y se pasan a cada grupo de rutas: así, por ejemplo, todos los comandos sobre una partida comparten cupo.
 */
export function playerLimits(app: FastifyInstance) {
  return {
    /** Comandos sobre una partida (acción, unirse, abandonar, revancha): de sobra para jugar a mano. */
    matchCommand: preHandler(createLimit(app, { max: 60, timeWindow: MINUTE, key: matchKey })),
    /** Lecturas de una partida, long-poll incluido: cada cambio despierta ~1-2 lecturas por jugador. */
    matchRead: preHandler(createLimit(app, { max: 240, timeWindow: MINUTE, key: matchKey })),
    /** Crear partidas (cada una reserva saldo). */
    createMatch: preHandler(createLimit(app, { max: 20, timeWindow: MINUTE, key: playerKey })),
    /** Cambio de contraseña y renovación de sesión, por cuenta. */
    session: preHandler(createLimit(app, { max: 10, timeWindow: MINUTE, key: playerKey })),
    /**
     * Intentos de login contra UNA cuenta, vengan de la IP que vengan (AUD-02): la fuerza bruta
     * repartida entre muchas IPs ya no multiplica el cupo de 10/min por IP.
     */
    loginPerAccount: preHandler(
      createLimit(app, {
        max: 10,
        timeWindow: MINUTE,
        key: (request) => {
          const name = (request.body as { displayName?: unknown } | undefined)?.displayName;
          return typeof name === "string" && name.trim() ? `login:${name.trim()}` : null;
        },
      }),
    ),
    /** Altas de cuentas por IP (AUD-22): cada cuenta nueva trae 1000 fichas; sin tope se "cultivan". */
    registration: createLimit(app, { max: 10, timeWindow: HOUR, key: (request) => `register:${request.ip}` }),
  };
}

export type PlayerLimits = ReturnType<typeof playerLimits>;
