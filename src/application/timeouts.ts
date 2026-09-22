import type { Hand, Match, Prisma } from "@prisma/client";
import { applyCheckOrBet } from "../domain/bettingEngine.js";
import { persistBettingRoundResult, toEngineState } from "./bettingRound.js";
import { applyDraw } from "./drawPhase.js";
import { advanceAfterBettingRoundClosed, advanceAfterDraw, advanceAfterFold } from "./handFlow.js";
import { logEvent } from "./events.js";
import { slotOfPlayer } from "./seats.js";

type Tx = Prisma.TransactionClient;

const MAX_CASCADED_TIMEOUTS = 12;

/**
 * Resuelve de forma perezosa cualquier turno vencido antes de leer o mutar más estado
 * (sección 2.4: "Si un turno expira..."). Se llama al inicio de cada comando y de cada
 * lectura de partida, ya que esta entrega no tiene un scheduler en segundo plano.
 */
export async function resolveExpiredTurns(
  tx: Tx,
  match: Match,
  hand: Hand | null,
): Promise<{ match: Match; hand: Hand | null }> {
  let currentMatch = match;
  let currentHand = hand;

  for (let i = 0; i < MAX_CASCADED_TIMEOUTS; i++) {
    if (!currentHand || !currentHand.turnExpiresAt || currentHand.turnExpiresAt.getTime() > Date.now()) {
      break;
    }
    if (currentHand.phase !== "DRAW" && currentHand.phase !== "BETTING_PRE_DRAW" && currentHand.phase !== "BETTING_POST_DRAW") {
      break;
    }
    if (!currentHand.toActPlayerId) break;

    const actorSlot = slotOfPlayer(currentMatch, currentHand.toActPlayerId);

    if (currentHand.phase === "DRAW") {
      const updatedHand = await applyDraw(tx, currentMatch, currentHand, actorSlot, []);
      await logEvent(tx, {
        matchId: currentMatch.id,
        handId: currentHand.id,
        type: "draw.completed",
        stateVersion: currentMatch.stateVersion,
        publicPayload: { playerId: currentHand.toActPlayerId, discardedCount: 0, auto: true },
      });
      await tx.action.create({
        data: {
          handId: currentHand.id,
          matchId: currentMatch.id,
          playerId: currentHand.toActPlayerId,
          type: "DRAW",
          discardedIndexes: [],
          actionVersion: currentMatch.stateVersion,
          isAuto: true,
        },
      });

      const advancedDraw = await advanceAfterDraw(tx, currentMatch, updatedHand, actorSlot);
      currentMatch = advancedDraw.match;
      currentHand = advancedDraw.hand;
      continue;
    }

    // Fases de apuestas: check si es legal, si no fold.
    const engineState = toEngineState(currentMatch, currentHand);
    const seat = engineState.toAct;
    const toCall = engineState.currentBet - engineState.contributions[seat];

    if (toCall <= 0) {
      const result = applyCheckOrBet(engineState, seat, 0);
      const persisted = await persistBettingRoundResult(tx, currentMatch, currentHand, result);
      await tx.action.create({
        data: {
          handId: currentHand.id,
          matchId: currentMatch.id,
          playerId: currentHand.toActPlayerId,
          type: "BET",
          amount: 0,
          actionVersion: currentMatch.stateVersion,
          isAuto: true,
        },
      });
      currentMatch = persisted.match;
      currentHand = persisted.hand;
      if (result.closed) {
        const advanced = await advanceAfterBettingRoundClosed(tx, currentMatch, currentHand);
        currentMatch = advanced.match;
        currentHand = advanced.hand;
      }
    } else {
      await tx.action.create({
        data: {
          handId: currentHand.id,
          matchId: currentMatch.id,
          playerId: currentHand.toActPlayerId,
          type: "FOLD",
          actionVersion: currentMatch.stateVersion,
          isAuto: true,
        },
      });
      const advanced = await advanceAfterFold(tx, currentMatch, currentHand, actorSlot);
      currentMatch = advanced.match;
      currentHand = advanced.hand;
    }
  }

  return { match: currentMatch, hand: currentHand };
}
