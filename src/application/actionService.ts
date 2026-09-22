import type { Hand, Match, Prisma } from "@prisma/client";
import { prisma } from "../infrastructure/prisma/client.js";
import { withIdempotency } from "../infrastructure/idempotency.js";
import { applyAllIn, applyCheckOrBet } from "../domain/bettingEngine.js";
import { DomainError } from "../domain/errors.js";
import { assertPhaseAllowsAction } from "../domain/stateMachine.js";
import type { ActionType } from "../domain/types.js";
import { advanceAfterBettingRoundClosed, advanceAfterDraw, advanceAfterFold } from "./handFlow.js";
import { persistBettingRoundResult, slotToSeat, buttonSlot, toEngineState } from "./bettingRound.js";
import { applyDraw, validateDiscardIndexes } from "./drawPhase.js";
import { resolveExpiredTurns } from "./timeouts.js";
import { buildMatchView } from "./handQueryService.js";
import { slotOfPlayer } from "./seats.js";

export interface SubmitActionInput {
  matchId: string;
  playerId: string;
  idempotencyKey: string;
  body: {
    type: ActionType;
    amount?: number;
    discardedIndexes?: number[];
    actionVersion: number;
  };
}

export interface SubmitActionOutput {
  status: number;
  body: {
    actionId: string;
    accepted: true;
    idempotentReplay: boolean;
    match: {
      id: string;
      phase: Hand["phase"] | null;
      stateVersion: number;
      turn: { playerId: string; expiresAt: string } | null;
    };
  };
}

async function loadMatchAndHand(
  tx: Prisma.TransactionClient,
  matchId: string,
): Promise<{ match: Match; hand: Hand | null }> {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
  const match = await tx.match.findUnique({ where: { id: matchId } });
  if (!match) {
    throw new DomainError("MATCH_NOT_FOUND", "La partida no existe o no es visible");
  }
  const hand = match.handNumber > 0
    ? await tx.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } })
    : null;
  return { match, hand };
}

function assertBelongsToMatch(match: Match, playerId: string): void {
  if (playerId !== match.player1Id && playerId !== match.player2Id) {
    throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
  }
}

export async function submitAction(input: SubmitActionInput): Promise<SubmitActionOutput> {
  // Paso 1: la resolución de timeouts es responsabilidad del servidor y debe confirmarse
  // sin importar si la acción de este cliente en particular resulta inválida o desactualizada
  // (si ambas cosas vivieran en la misma transacción, un STALE_STATE revertiría también los
  // timeouts ya vencidos de otros turnos).
  await prisma.$transaction(async (tx) => {
    const { match, hand } = await loadMatchAndHand(tx, input.matchId);
    assertBelongsToMatch(match, input.playerId);
    await resolveExpiredTurns(tx, match, hand);
  });

  // Paso 2: procesa la acción de este cliente sobre el estado ya al día.
  return prisma.$transaction(async (tx) => {
    let { match, hand } = await loadMatchAndHand(tx, input.matchId);
    assertBelongsToMatch(match, input.playerId);

    const result = await withIdempotency(
      tx,
      { playerId: input.playerId, key: input.idempotencyKey, requestBody: input.body },
      async () => {
        if (input.body.actionVersion !== match.stateVersion) {
          throw new DomainError("STALE_STATE", "actionVersion desactualizado", {
            currentState: hand ? buildMatchView(match, hand, input.playerId) : null,
          });
        }
        if (match.status !== "IN_PROGRESS" || !hand) {
          throw new DomainError("INVALID_ACTION", "La partida no está en curso");
        }

        assertPhaseAllowsAction(hand.phase, input.body.type);
        if (hand.toActPlayerId !== input.playerId) {
          throw new DomainError("INVALID_ACTION", "No es el turno de este jugador");
        }

        const actorSlot = slotOfPlayer(match, input.playerId);
        let actionRecord: { id: string };

        if (input.body.type === "DRAW") {
          const discardedIndexes = input.body.discardedIndexes ?? [];
          validateDiscardIndexes(discardedIndexes, match.maxDiscard);
          const handAfterDraw = await applyDraw(tx, match, hand, actorSlot, discardedIndexes);
          actionRecord = await tx.action.create({
            data: {
              handId: hand.id,
              matchId: match.id,
              playerId: input.playerId,
              type: "DRAW",
              discardedIndexes,
              actionVersion: match.stateVersion,
            },
          });
          const advancedDraw = await advanceAfterDraw(tx, match, handAfterDraw, actorSlot);
          match = advancedDraw.match;
          hand = advancedDraw.hand;
        } else if (input.body.type === "FOLD") {
          actionRecord = await tx.action.create({
            data: {
              handId: hand.id,
              matchId: match.id,
              playerId: input.playerId,
              type: "FOLD",
              actionVersion: match.stateVersion,
            },
          });
          const advanced = await advanceAfterFold(tx, match, hand, actorSlot);
          match = advanced.match;
          hand = advanced.hand;
        } else {
          const engineState = toEngineState(match, hand);
          const button = buttonSlot(match, hand);
          const seat = slotToSeat(button, actorSlot);

          const bettingResult =
            input.body.type === "ALL_IN"
              ? applyAllIn(engineState, seat)
              : applyCheckOrBet(engineState, seat, input.body.amount ?? 0);

          actionRecord = await tx.action.create({
            data: {
              handId: hand.id,
              matchId: match.id,
              playerId: input.playerId,
              type: input.body.type,
              amount:
                input.body.type === "BET" ? (input.body.amount ?? 0) : bettingResult.state.contributions[seat],
              actionVersion: match.stateVersion,
            },
          });

          const persisted = await persistBettingRoundResult(tx, match, hand, bettingResult);
          match = persisted.match;
          hand = persisted.hand;

          if (bettingResult.closed) {
            const advanced = await advanceAfterBettingRoundClosed(tx, match, hand);
            match = advanced.match;
            hand = advanced.hand;
          }
        }

        return {
          status: 200,
          body: {
            actionId: actionRecord.id,
            accepted: true as const,
            match: {
              id: match.id,
              phase: hand?.phase ?? null,
              stateVersion: match.stateVersion,
              turn: hand?.toActPlayerId && hand.turnExpiresAt
                ? { playerId: hand.toActPlayerId, expiresAt: hand.turnExpiresAt.toISOString() }
                : null,
            },
          },
        };
      },
    );

    return {
      status: result.status,
      body: { ...result.body, idempotentReplay: result.idempotentReplay },
    };
  });
}
