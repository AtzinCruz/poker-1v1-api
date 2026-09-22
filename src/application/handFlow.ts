import type { Hand, Match, Prisma } from "@prisma/client";
import { nextPhaseAfterBettingRoundClosed } from "../domain/stateMachine.js";
import { dealNewHand, finishHand, foldOutcome, resolveShowdown } from "./dealing.js";
import { logEvent } from "./events.js";
import { buttonSlot, firstActorForNewRound, startBettingRound } from "./bettingRound.js";
import { otherSlot, playerIdOfSlot, readSlot, slotUpdate, type Slot } from "./seats.js";

type Tx = Prisma.TransactionClient;

export interface HandFlowResult {
  match: Match;
  hand: Hand | null;
  matchFinished: boolean;
}

/** Ronda BETTING_PRE_DRAW cerrada → DRAW; BETTING_POST_DRAW cerrada → showdown y liquidación. */
export async function advanceAfterBettingRoundClosed(
  tx: Tx,
  match: Match,
  hand: Hand,
): Promise<HandFlowResult> {
  const nextPhase = nextPhaseAfterBettingRoundClosed(hand.phase as "BETTING_PRE_DRAW" | "BETTING_POST_DRAW");

  if (nextPhase === "DRAW") {
    const button = buttonSlot(match, hand);
    const updatedHand = await tx.hand.update({
      where: { id: hand.id },
      data: {
        phase: "DRAW",
        toActPlayerId: playerIdOfSlot(match, button),
        turnExpiresAt: new Date(Date.now() + match.turnTimeoutSeconds * 1000),
      },
    });
    await logEvent(tx, {
      matchId: match.id,
      handId: hand.id,
      type: "match.updated",
      stateVersion: match.stateVersion,
      publicPayload: { phase: "DRAW", toActPlayerId: updatedHand.toActPlayerId },
    });
    return { match, hand: updatedHand, matchFinished: false };
  }

  return resolveShowdownAndContinue(tx, match, hand);
}

export async function resolveShowdownAndContinue(tx: Tx, match: Match, hand: Hand): Promise<HandFlowResult> {
  const outcome = resolveShowdown(hand, match);
  const settled = await finishHand(tx, match, hand, outcome, true);
  const deal = await dealNewHand(tx, settled.match);
  return { match: deal.match, hand: deal.hand, matchFinished: deal.matchFinished };
}

export async function advanceAfterFold(tx: Tx, match: Match, hand: Hand, folderSlot: Slot): Promise<HandFlowResult> {
  const markedFolded = await tx.hand.update({
    where: { id: hand.id },
    data: slotUpdate(folderSlot, { folded: true }),
  });
  const outcome = foldOutcome(markedFolded, folderSlot);
  const settled = await finishHand(tx, match, markedFolded, outcome, false);
  const deal = await dealNewHand(tx, settled.match);
  return { match: deal.match, hand: deal.hand, matchFinished: deal.matchFinished };
}

/** Tras un DRAW: si el rival ya había descartado, arranca la ronda post-draw; si no, le pasa el turno. */
export async function advanceAfterDraw(
  tx: Tx,
  match: Match,
  handAfterDraw: Hand,
  actorSlot: Slot,
): Promise<HandFlowResult> {
  const opponentSlot = otherSlot(actorSlot);
  const opponentView = readSlot(handAfterDraw, opponentSlot);
  if (opponentView.discarded) {
    return advanceAfterBothDrew(tx, match, handAfterDraw);
  }
  const updated = await tx.hand.update({
    where: { id: handAfterDraw.id },
    data: {
      toActPlayerId: playerIdOfSlot(match, opponentSlot),
      turnExpiresAt: new Date(Date.now() + match.turnTimeoutSeconds * 1000),
    },
  });
  return { match, hand: updated, matchFinished: false };
}

/**
 * DRAW: cuando ambos jugadores ya descartaron, arranca la ronda BETTING_POST_DRAW.
 * Si alguno ya está all-in, empieza el otro; si ambos lo están, no hay apuestas posibles
 * y se va directo a showdown (sección 2.4: "hay all-in y no queda decisión de apuesta").
 */
export async function advanceAfterBothDrew(tx: Tx, match: Match, hand: Hand): Promise<HandFlowResult> {
  const button = buttonSlot(match, hand);
  const buttonView = readSlot(hand, button);
  const otherView = readSlot(hand, otherSlot(button));
  const firstActor = firstActorForNewRound(button, buttonView.allIn, otherView.allIn);

  if (firstActor === null) {
    return resolveShowdownAndContinue(tx, match, hand);
  }

  const updated = await startBettingRound(tx, match, hand, firstActor);
  await logEvent(tx, {
    matchId: match.id,
    handId: hand.id,
    type: "match.updated",
    stateVersion: match.stateVersion,
    publicPayload: { phase: "BETTING_POST_DRAW", toActPlayerId: updated.toActPlayerId },
  });
  return { match, hand: updated, matchFinished: false };
}
