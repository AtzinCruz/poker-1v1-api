import { prisma } from "../infrastructure/prisma/client.js";
import { runTransaction } from "../infrastructure/prisma/transaction.js";
import { config } from "../config.js";
import { tryLockAndLoadMatch, tryLockAndLoadMatchAfterParent } from "./locks.js";
import { cancelWaitingMatch } from "./matchService.js";
import { resolveExpiredTurns } from "./timeouts.js";

/** Una invitación que nadie aceptó en este tiempo se cancela y se libera la reserva de su creador. */
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Las claves de idempotencia solo protegen reintentos cercanos (red inestable, doble clic). Pasado
 * este tiempo se purgan; reusar una clave más vieja ejecuta la petición de nuevo.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PURGE_BATCH = 5000;
/** Partidas por lote al purgar: cada una arrastra sus manos, acciones y eventos. */
const MATCH_PURGE_BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Partidas por pasada del barrido (cada 15 s). Antes eran 50 sin orden: ~3 partidas/s como máximo. */
export const SWEEP_BATCH = 200;

export type MaintenanceErrorHandler = (error: unknown, context: string) => void;

const logToConsole: MaintenanceErrorHandler = (error, context) => {
  console.error(`[mantenimiento] ${context}`, error);
};

/**
 * Aplica los timeouts de turno vencidos aunque nadie esté consultando la partida. Sin esto, si
 * ambos jugadores se van, la partida y los saldos bloqueados quedaban congelados para siempre.
 *
 * Cada partida va en su propia transacción y su propio try/catch: una partida en mal estado no
 * debe impedir que se procesen las demás. Devuelve cuántas partidas se procesaron sin error.
 */
export async function sweepExpiredTurns(
  now: Date = new Date(),
  onError: MaintenanceErrorHandler = logToConsole,
  limit: number = SWEEP_BATCH,
): Promise<number> {
  // Las más atrasadas primero (índice Hand.turnExpiresAt): si hay más vencidas que `limit`, ninguna
  // espera indefinidamente detrás de otras más recientes.
  const due = await prisma.$queryRaw<{ matchId: string }[]>`
    SELECT h."matchId" FROM "Hand" h
    JOIN "Match" m ON m.id = h."matchId" AND m."handNumber" = h.number
    WHERE h."turnExpiresAt" < ${now}
      AND h.phase IN ('DRAW', 'BETTING_PRE_DRAW', 'BETTING_POST_DRAW')
      AND m.status = 'IN_PROGRESS'
    ORDER BY h."turnExpiresAt"
    LIMIT ${limit}`;

  let processed = 0;
  for (const { matchId } of due) {
    try {
      const handled = await runTransaction(async (tx) => {
        // SKIP LOCKED: si una petición u otra instancia ya tiene la partida, ella resuelve el turno.
        const match = await tryLockAndLoadMatch(tx, matchId);
        if (!match || match.status !== "IN_PROGRESS") return false;
        const hand = await tx.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } });
        await resolveExpiredTurns(tx, match, hand);
        return true;
      });
      if (handled) processed += 1;
    } catch (error) {
      onError(error, `turnos vencidos de la partida ${matchId}`);
    }
  }
  return processed;
}

export async function expireStaleInvitations(
  ttlMs: number = INVITATION_TTL_MS,
  onError: MaintenanceErrorHandler = logToConsole,
): Promise<number> {
  const stale = await prisma.match.findMany({
    where: { status: "WAITING_FOR_OPPONENT", createdAt: { lt: new Date(Date.now() - ttlMs) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  });

  let cancelled = 0;
  for (const { id } of stale) {
    try {
      await runTransaction(async (tx) => {
        // Si es una revancha, la original se bloquea antes (orden global de locks, AUD-04).
        const match = await tryLockAndLoadMatchAfterParent(tx, id);
        if (!match || match.status !== "WAITING_FOR_OPPONENT") return;
        await cancelWaitingMatch(tx, match);
        cancelled += 1;
      });
    } catch (error) {
      onError(error, `invitación vencida ${id}`);
    }
  }
  return cancelled;
}

/**
 * Borra registros de idempotencia vencidos en lotes (índice IdempotencyRecord.createdAt): un DELETE
 * único sobre millones de filas bloquearía la tabla y llenaría el WAL de golpe.
 */
export async function purgeIdempotencyRecords(ttlMs: number = IDEMPOTENCY_TTL_MS): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "IdempotencyRecord"
      WHERE id IN (SELECT id FROM "IdempotencyRecord" WHERE "createdAt" < ${cutoff} LIMIT ${PURGE_BATCH})`;
    total += deleted;
    if (deleted < PURGE_BATCH) return total;
  }
}

/**
 * AUD-19: Action y GameEvent crecían sin límite. Se purgan partidas ENTERAS (con sus manos, acciones
 * y eventos) terminadas o canceladas hace más de `retentionMs`, en lotes: la auditoría de una partida
 * reciente nunca queda a medias. Ninguna partida dura tanto (el abandono por desconexión la cierra en
 * minutos), así que basta mirar createdAt (índice Match.status+createdAt).
 */
export async function purgeOldMatches(retentionMs: number = config.matchRetentionDays * DAY_MS): Promise<number> {
  if (retentionMs <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionMs);
  let total = 0;
  for (;;) {
    const deleted = await prisma.$transaction(async (tx) => {
      const old = await tx.match.findMany({
        where: { status: { in: ["MATCH_FINISHED", "CANCELLED"] }, createdAt: { lt: cutoff } },
        select: { id: true },
        take: MATCH_PURGE_BATCH,
      });
      const ids = old.map((m) => m.id);
      if (ids.length === 0) return 0;
      await tx.gameEvent.deleteMany({ where: { matchId: { in: ids } } });
      await tx.action.deleteMany({ where: { matchId: { in: ids } } });
      await tx.hand.deleteMany({ where: { matchId: { in: ids } } });
      // Una partida que se queda puede apuntar a una revancha que se va: se suelta el vínculo.
      await tx.match.updateMany({ where: { rematchMatchId: { in: ids } }, data: { rematchMatchId: null } });
      return (await tx.match.deleteMany({ where: { id: { in: ids } } })).count;
    });
    total += deleted;
    if (deleted < MATCH_PURGE_BATCH) return total;
  }
}

/** Registros de ajustes de admin más viejos que la retención (por defecto 2 años; 0 = nunca). */
export async function purgeAdminActions(retentionMs: number = config.adminActionRetentionDays * DAY_MS): Promise<number> {
  if (retentionMs <= 0) return 0;
  const { count } = await prisma.adminAction.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - retentionMs) } } });
  return count;
}

/** Las tareas son independientes: si una falla por completo, las demás igual corren. */
export async function runMaintenance(onError: MaintenanceErrorHandler = logToConsole): Promise<void> {
  for (const [name, task] of [
    ["barrido de turnos vencidos", () => sweepExpiredTurns(new Date(), onError)],
    ["cancelación de invitaciones", () => expireStaleInvitations(INVITATION_TTL_MS, onError)],
    ["purga de idempotencia", () => purgeIdempotencyRecords()],
    ["purga de partidas viejas", () => purgeOldMatches()],
    ["purga de registros de admin", () => purgeAdminActions()],
  ] as const) {
    try {
      await task();
    } catch (error) {
      onError(error, name);
    }
  }
}
