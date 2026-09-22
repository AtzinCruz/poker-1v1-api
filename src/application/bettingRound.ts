import type { Hand, Match, Prisma } from "@prisma/client";
import type { BettingRoundResult, BettingRoundState, Seat } from "../domain/bettingEngine.js";
import { getMatchStack, matchStackField, otherSlot, playerIdOfSlot, readSlot, slotOfPlayer, slotUpdate, type Slot } from "./seats.js";

type Tx = Prisma.TransactionClient;

export function buttonSlot(match: Match, hand: Hand): Slot {
  return slotOfPlayer(match, hand.dealerPlayerId);
}

export function slotToSeat(button: Slot, slot: Slot): Seat {
  return slot === button ? 0 : 1;
}

export function seatToSlot(button: Slot, seat: Seat): Slot {
  return seat === 0 ? button : otherSlot(button);
}

/**
 * Quién debe actuar primero en una ronda de apuestas nueva: el botón, salvo que ya esté
 * all-in (p. ej. su ciega lo dejó en 0, o llegó all-in desde la ronda anterior), en cuyo caso
 * le toca al rival. Si ambos ya están all-in, no hay ronda que jugar (null).
 */
export function firstActorForNewRound(button: Slot, buttonAllIn: boolean, otherAllIn: boolean): Slot | null {
  if (buttonAllIn && otherAllIn) return null;
  return buttonAllIn ? otherSlot(button) : button;
}

/** Reconstruye el estado del motor de apuestas a partir de las columnas persistidas de Hand/Match. */
export function toEngineState(match: Match, hand: Hand): BettingRoundState {
  const button = buttonSlot(match, hand);
  const other = otherSlot(button);
  const bView = readSlot(hand, button);
  const oView = readSlot(hand, other);

  if (!hand.toActPlayerId) {
    throw new Error("La mano no tiene un jugador en turno para reconstruir la ronda de apuestas");
  }

  return {
    currentBet: hand.currentBet,
    lastRaiseSize: hand.lastFullRaise,
    contributions: [bView.contribution - bView.roundStartContribution, oView.contribution - oView.roundStartContribution],
    stacks: [getMatchStack(match, button), getMatchStack(match, other)],
    allIn: [bView.allIn, oView.allIn],
    actedThisRound: [bView.actedInRound, oView.actedInRound],
    toAct: slotToSeat(button, slotOfPlayer(match, hand.toActPlayerId)),
  };
}

/**
 * Persiste el resultado de una acción de apuesta (BET/ALL_IN) contra Hand y Match.
 * No decide la transición de fase — eso lo hace el caller según `result.closed`.
 */
export async function persistBettingRoundResult(
  tx: Tx,
  match: Match,
  hand: Hand,
  result: BettingRoundResult,
): Promise<{ match: Match; hand: Hand }> {
  const button = buttonSlot(match, hand);
  const other = otherSlot(button);
  const bView = readSlot(hand, button);
  const oView = readSlot(hand, other);
  const buttonSeat: Seat = 0;
  const otherSeat: Seat = 1;

  const newButtonContribution = bView.roundStartContribution + result.state.contributions[buttonSeat];
  const newOtherContribution = oView.roundStartContribution + result.state.contributions[otherSeat];

  const updatedMatch = await tx.match.update({
    where: { id: match.id },
    data: {
      [matchStackField(button)]: result.state.stacks[buttonSeat],
      [matchStackField(other)]: result.state.stacks[otherSeat],
    },
  });

  const updatedHand = await tx.hand.update({
    where: { id: hand.id },
    data: {
      currentBet: result.state.currentBet,
      lastFullRaise: result.state.lastRaiseSize,
      pot: newButtonContribution + newOtherContribution,
      ...slotUpdate(button, {
        contribution: newButtonContribution,
        allIn: result.state.allIn[buttonSeat],
        actedInRound: result.state.actedThisRound[buttonSeat],
      }),
      ...slotUpdate(other, {
        contribution: newOtherContribution,
        allIn: result.state.allIn[otherSeat],
        actedInRound: result.state.actedThisRound[otherSeat],
      }),
      ...(result.closed
        ? { toActPlayerId: null, turnExpiresAt: null }
        : {
            toActPlayerId: playerIdOfSlot(match, seatToSlot(button, result.state.toAct)),
            turnExpiresAt: new Date(Date.now() + match.turnTimeoutSeconds * 1000),
          }),
    },
  });

  return { match: updatedMatch, hand: updatedHand };
}

/** Arranca una nueva ronda de apuestas (post-draw): currentBet=0, mínimo de apertura = ciega grande. */
export async function startBettingRound(
  tx: Tx,
  match: Match,
  hand: Hand,
  firstToActSlot: Slot,
): Promise<Hand> {
  return tx.hand.update({
    where: { id: hand.id },
    data: {
      phase: "BETTING_POST_DRAW",
      currentBet: 0,
      lastFullRaise: match.bigBlind,
      toActPlayerId: playerIdOfSlot(match, firstToActSlot),
      turnExpiresAt: new Date(Date.now() + match.turnTimeoutSeconds * 1000),
      player1RoundStartContribution: hand.player1Contribution,
      player2RoundStartContribution: hand.player2Contribution,
      player1ActedInRound: false,
      player2ActedInRound: false,
    },
  });
}
