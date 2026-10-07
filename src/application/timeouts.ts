import type { Hand, Match, Prisma } from "@prisma/client";
import { applyCheckOrBet } from "../domain/bettingEngine.js";
import { persistBettingRoundResult, toEngineState } from "./bettingRound.js";
import { applyDraw, bumpStateVersion } from "./drawPhase.js";
import { advanceAfterBettingRoundClosed, advanceAfterDraw, advanceAfterFold } from "./handFlow.js";
import { finishMatchByForfeit } from "./forfeit.js";
import { logEvent } from "./events.js";
import { slotOfPlayer } from "./seats.js";

type Tx = Prisma.TransactionClient;

const MAX_CASCADED_TIMEOUTS = 12;

/**
 * Cuántas acciones automáticas SEGUIDAS (sin que el jugador actúe él mismo en medio) se toleran
 * antes de darlo por desconectado y terminar la partida con DISCONNECT_TIMEOUT. Con el turno
 * predeterminado de 60 s son ~3 minutos de silencio.
 */
export const DISCONNECT_AFTER_AUTO_ACTIONS = 3;

async function currentHandOf(tx: Tx, match: Match): Promise<Hand | null> {
  return match.handNumber > 0
    ? tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber } } })
    : null;
}

async function hasBeenSilent(tx: Tx, matchId: string, playerId: string): Promise<boolean> {
  const recent = await tx.action.findMany({
    where: { matchId, playerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: DISCONNECT_AFTER_AUTO_ACTIONS,
  });
  return recent.length === DISCONNECT_AFTER_AUTO_ACTIONS && recent.every((a) => a.isAuto);
}

/**
 * Resuelve de forma perezosa cualquier turno vencido antes de leer o mutar más estado
 * (sección 2.4: "Si un turno expira..."). Se llama al inicio de cada comando, de cada lectura de
 * partida y desde el barrido en segundo plano (maintenance.ts). Debe invocarse con la fila de
 * Match bloqueada (lockMatch).
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

    if (currentHand.phase === "DRAW") {
      const updatedHand = await applyDraw(tx, currentMatch, currentHand, actorSlot, []);
      await logEvent(tx, {
        matchId: currentMatch.id,
        handId: currentHand.id,
        type: "draw.completed",
        stateVersion: currentMatch.stateVersion,
        publicPayload: { playerId: actorId, discardedCount: 0, auto: true },
      });
      await tx.action.create({
        data: {
          handId: currentHand.id,
          matchId: currentMatch.id,
          playerId: actorId,
          type: "DRAW",
          discardedIndexes: [],
          actionVersion: currentMatch.stateVersion,
          isAuto: true,
        },
      });

      currentMatch = await bumpStateVersion(tx, currentMatch);
      const advancedDraw = await advanceAfterDraw(tx, currentMatch, updatedHand, actorSlot);
      currentMatch = advancedDraw.match;
      currentHand = advancedDraw.hand;
    } else {
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
            playerId: actorId,
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
            playerId: actorId,
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

    // ¿Dejó de responder? Varias acciones automáticas seguidas → abandono por desconexión.
    if (currentMatch.status === "IN_PROGRESS" && (await hasBeenSilent(tx, currentMatch.id, actorId))) {
      currentMatch = await finishMatchByForfeit(tx, currentMatch, actorId, "DISCONNECT_TIMEOUT");
      currentHand = await currentHandOf(tx, currentMatch);
      break;
    }
  }

  return { match: currentMatch, hand: currentHand };
}
