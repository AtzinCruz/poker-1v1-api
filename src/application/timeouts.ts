import type { Hand, Match, Prisma } from "@prisma/client";
import { applyCheckOrBet } from "../domain/bettingEngine.js";
import { persistBettingRoundResult, toEngineState } from "./bettingRound.js";
import { applyDraw, bumpStateVersion } from "./drawPhase.js";
import { advanceAfterBettingRoundClosed, advanceAfterDraw, advanceAfterFold } from "./handFlow.js";
import { finishMatchByForfeit } from "./forfeit.js";
import { recordAction } from "./actionLog.js";
import { slotOfPlayer } from "./seats.js";
import { notifyMatchChanged } from "../infrastructure/matchNotifier.js";

type Tx = Prisma.TransactionClient;

const MAX_CASCADED_TIMEOUTS = 12;

/** Segundos mínimos de silencio de un jugador antes de darlo por desconectado. */
export const DISCONNECT_MIN_SILENCE_SECONDS = 180;

/**
 * Cuántas acciones automáticas SEGUIDAS (sin que el jugador actúe él mismo en medio) se toleran antes
 * de darlo por desconectado. Escala con el tiempo por turno para que el umbral sea de tiempo real
 * (~3 min) y no de cantidad: con turnos de 15 s no bastan 3 acciones (45 s) para perder la partida.
 */
export function disconnectThreshold(turnTimeoutSeconds: number): number {
  return Math.max(3, Math.ceil(DISCONNECT_MIN_SILENCE_SECONDS / turnTimeoutSeconds));
}

async function currentHandOf(tx: Tx, match: Match): Promise<Hand | null> {
  return match.handNumber > 0
    ? tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber } } })
    : null;
}

async function hasBeenSilent(tx: Tx, match: Match, playerId: string): Promise<boolean> {
  const threshold = disconnectThreshold(match.turnTimeoutSeconds);
  const recent = await tx.action.findMany({
    where: { matchId: match.id, playerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: threshold,
  });
  return recent.length === threshold && recent.every((a) => a.isAuto);
}

/**
 * Resuelve de forma perezosa cualquier turno vencido antes de leer o mutar más estado
 * (sección 2.4: "Si un turno expira..."). Se llama al inicio de cada comando, de cada lectura de
 * partida y desde el barrido en segundo plano (maintenance.ts). Debe invocarse con la fila de
 * Match bloqueada (lockAndLoadMatch).
 */
export async function resolveExpiredTurns(
  tx: Tx,
  match: Match,
  hand: Hand | null,
): Promise<{ match: Match; hand: Hand | null }> {
  let currentMatch = match;
  let currentHand = hand;

  for (let i = 0; i < MAX_CASCADED_TIMEOUTS; i++) {
    // Una partida terminada (resign, saldo insuficiente...) nunca debe reanudarse por un turno viejo.
    if (currentMatch.status !== "IN_PROGRESS") break;
    if (!currentHand || !currentHand.turnExpiresAt || currentHand.turnExpiresAt.getTime() > Date.now()) {
      break;
    }
    if (currentHand.phase !== "DRAW" && currentHand.phase !== "BETTING_PRE_DRAW" && currentHand.phase !== "BETTING_POST_DRAW") {
      break;
    }
    if (!currentHand.toActPlayerId) break;

    const actorId = currentHand.toActPlayerId;
    const actorSlot = slotOfPlayer(currentMatch, actorId);
    // Cada acción automática queda registrada como cualquier otra (AUD-10): estado anterior y posterior.
    const record = {
      handId: currentHand.id,
      matchId: currentMatch.id,
      playerId: actorId,
      actionVersion: currentMatch.stateVersion,
      isAuto: true,
    };

    if (currentHand.phase === "DRAW") {
      const updatedHand = await applyDraw(tx, currentMatch, currentHand, actorSlot, [], { auto: true });
      currentMatch = await bumpStateVersion(tx, currentMatch);
      const advancedDraw = await advanceAfterDraw(tx, currentMatch, updatedHand, actorSlot);
      currentMatch = advancedDraw.match;
      currentHand = advancedDraw.hand;
      await recordAction(tx, { ...record, type: "DRAW", discardedIndexes: [] }, { match: currentMatch, hand: currentHand });
    } else {
      // Fases de apuestas: check si es legal, si no fold.
      const engineState = toEngineState(currentMatch, currentHand);
      const seat = engineState.toAct;
      const toCall = engineState.currentBet - engineState.contributions[seat];

      if (toCall <= 0) {
        const result = applyCheckOrBet(engineState, seat, 0);
        const persisted = await persistBettingRoundResult(tx, currentMatch, currentHand, result, actorId);
        currentMatch = persisted.match;
        currentHand = persisted.hand;
        if (result.closed) {
          const advanced = await advanceAfterBettingRoundClosed(tx, currentMatch, currentHand);
          currentMatch = advanced.match;
          currentHand = advanced.hand;
        }
        await recordAction(tx, { ...record, type: "BET", amount: 0 }, { match: currentMatch, hand: currentHand });
      } else {
        const advanced = await advanceAfterFold(tx, currentMatch, currentHand, actorSlot, { auto: true });
        currentMatch = advanced.match;
        currentHand = advanced.hand;
        await recordAction(tx, { ...record, type: "FOLD" }, { match: currentMatch, hand: currentHand });
      }
    }

    // ¿Dejó de responder? Varias acciones automáticas seguidas → abandono por desconexión.
    if (currentMatch.status === "IN_PROGRESS" && (await hasBeenSilent(tx, currentMatch, actorId))) {
      currentMatch = await finishMatchByForfeit(tx, currentMatch, actorId, "DISCONNECT_TIMEOUT");
      currentHand = await currentHandOf(tx, currentMatch);
      break;
    }
  }

  // Cubre todos los caminos que resuelven timeouts: GET, paso 1 de acciones y resign, y el barrido.
  if (currentMatch.stateVersion !== match.stateVersion) {
    await notifyMatchChanged(tx, currentMatch.id);
  }
  return { match: currentMatch, hand: currentHand };
}
