import { prisma } from "../infrastructure/prisma/client.js";
import { lockMatch } from "./locks.js";
import { cancelWaitingMatch } from "./matchService.js";
import { resolveExpiredTurns } from "./timeouts.js";

/** Una invitación que nadie aceptó en este tiempo se cancela y se libera la reserva de su creador. */
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

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
): Promise<number> {
  const due = await prisma.hand.findMany({
    where: {
      turnExpiresAt: { lt: now },
      phase: { in: ["DRAW", "BETTING_PRE_DRAW", "BETTING_POST_DRAW"] },
      match: { status: "IN_PROGRESS" },
    },
    select: { matchId: true },
    take: 50,
  });

  let processed = 0;
  for (const { matchId } of due) {
    try {
      await prisma.$transaction(async (tx) => {
        await lockMatch(tx, matchId);
        const match = await tx.match.findUnique({ where: { id: matchId } });
        if (!match || match.status !== "IN_PROGRESS") return;
        const hand = await tx.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } });
        await resolveExpiredTurns(tx, match, hand);
      });
      processed += 1;
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
    take: 50,
  });

  let cancelled = 0;
  for (const { id } of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        await lockMatch(tx, id);
        const match = await tx.match.findUnique({ where: { id } });
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

/** Las dos tareas son independientes: si una falla por completo, la otra igual corre. */
export async function runMaintenance(onError: MaintenanceErrorHandler = logToConsole): Promise<void> {
  for (const [name, task] of [
    ["barrido de turnos vencidos", () => sweepExpiredTurns(new Date(), onError)],
    ["cancelación de invitaciones", () => expireStaleInvitations(INVITATION_TTL_MS, onError)],
  ] as const) {
    try {
      await task();
    } catch (error) {
      onError(error, name);
    }
  }
}
