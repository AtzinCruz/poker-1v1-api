import type { Hand, Match, Prisma } from "@prisma/client";
import { formatCard, parseCard } from "../domain/card.js";
import { commitSeed, generateSeed, shuffleWithSeed } from "../domain/deck.js";
import { compareHandRank, evaluateHand } from "../domain/handEvaluator.js";
import type { HandWinReason } from "../domain/types.js";
import { getMatchStack, otherSlot, slotOfPlayer, slotUpdate, type Slot } from "./seats.js";
import { refundReservedStack } from "./walletSettlement.js";
import { firstActorForNewRound } from "./bettingRound.js";

type Tx = Prisma.TransactionClient;

export interface DealResult {
  hand: Hand | null;
  match: Match;
  /** true si la partida terminó (nadie puede cubrir la siguiente mano) en vez de repartir. */
  matchFinished: boolean;
}

function nextDealerSlot(match: Match): Slot {
  if (!match.dealerPlayerId) return "player1";
  return otherSlot(slotOfPlayer(match, match.dealerPlayerId));
}

/**
 * Reparte una nueva mano si ambos jugadores cubren las ciegas; si no, termina la partida
 * (sección 9: "Saldo inferior a la entrada" / "no puede cubrir la ciega grande de la siguiente mano").
 */
export async function dealNewHand(tx: Tx, matchIn: Match): Promise<DealResult> {
  const buttonSlot = nextDealerSlot(matchIn);
  const otherSlotValue = otherSlot(buttonSlot);
  const buttonStack = getMatchStack(matchIn, buttonSlot);
  const otherStack = getMatchStack(matchIn, otherSlotValue);

  if (buttonStack < matchIn.smallBlind || otherStack < matchIn.bigBlind) {
    const winnerSlot = otherStack >= matchIn.bigBlind ? otherSlotValue : buttonSlot;
    const winnerId = winnerSlot === "player1" ? matchIn.player1Id : matchIn.player2Id!;
    const match = await tx.match.update({
      where: { id: matchIn.id },
      data: {
        status: "MATCH_FINISHED",
        finishReason: "INSUFFICIENT_STACK",
        winnerId,
        stateVersion: { increment: 1 },
      },
    });
    await refundReservedStack(tx, {
      playerId: matchIn.player1Id,
      reservedAmount: matchIn.startingStack,
      finalStack: matchIn.player1Stack ?? matchIn.startingStack,
    });
    await refundReservedStack(tx, {
      playerId: matchIn.player2Id!,
      reservedAmount: matchIn.startingStack,
      finalStack: matchIn.player2Stack ?? matchIn.startingStack,
    });

    await tx.gameEvent.create({
      data: {
        matchId: match.id,
        type: "match.finished",
        stateVersion: match.stateVersion,
        publicPayload: {
          winnerId,
          reason: "INSUFFICIENT_STACK",
          finalStacks: { player1: match.player1Stack, player2: match.player2Stack },
        },
      },
    });
    return { hand: null, match, matchFinished: true };
  }

  const seed = generateSeed();
  const commitment = commitSeed(seed);
  const deck = shuffleWithSeed(seed);
  const buttonCards = deck.slice(0, 5);
  const otherCards = deck.slice(5, 10);

  const buttonId = buttonSlot === "player1" ? matchIn.player1Id : matchIn.player2Id!;

  const player1Cards = buttonSlot === "player1" ? buttonCards : otherCards;
  const player2Cards = buttonSlot === "player1" ? otherCards : buttonCards;
  const player1Contribution = buttonSlot === "player1" ? matchIn.smallBlind : matchIn.bigBlind;
  const player2Contribution = buttonSlot === "player1" ? matchIn.bigBlind : matchIn.smallBlind;
  const player1StackAfterBlind = matchIn.player1Stack! - player1Contribution;
  const player2StackAfterBlind = matchIn.player2Stack! - player2Contribution;
  const player1AllIn = player1StackAfterBlind === 0;
  const player2AllIn = player2StackAfterBlind === 0;

  const match = await tx.match.update({
    where: { id: matchIn.id },
    data: {
      status: "IN_PROGRESS",
      dealerPlayerId: buttonId,
      handNumber: { increment: 1 },
      stateVersion: { increment: 1 },
      player1Stack: player1StackAfterBlind,
      player2Stack: player2StackAfterBlind,
    },
  });

  const turnExpiresAt = new Date(Date.now() + match.turnTimeoutSeconds * 1000);

  // Caso extremo: alguno (o ambos) queda all-in con solo postear la ciega. Si es así, esa
  // ronda de apuestas no tiene decisiones posibles (sección 2.4); ver ajuste de fase abajo.
  const buttonAllIn = buttonSlot === "player1" ? player1AllIn : player2AllIn;
  const otherAllIn = buttonSlot === "player1" ? player2AllIn : player1AllIn;
  const firstActor = firstActorForNewRound(buttonSlot, buttonAllIn, otherAllIn);

  const hand = await tx.hand.create({
    data: {
      matchId: match.id,
      number: match.handNumber,
      phase: firstActor === null ? "DRAW" : "BETTING_PRE_DRAW",
      dealerPlayerId: buttonId,
      deckCommitment: commitment,
      deckSeed: seed,
      pot: player1Contribution + player2Contribution,
      currentBet: match.bigBlind,
      lastFullRaise: match.bigBlind,
      player1Cards: player1Cards.map(formatCard),
      player2Cards: player2Cards.map(formatCard),
      player1Contribution,
      player2Contribution,
      player1RoundStartContribution: 0,
      player2RoundStartContribution: 0,
      ...slotUpdate("player1", { allIn: player1AllIn }),
      ...slotUpdate("player2", { allIn: player2AllIn }),
      toActPlayerId: firstActor === null ? buttonId : (firstActor === "player1" ? match.player1Id : match.player2Id),
      turnExpiresAt,
    },
  });

  await tx.gameEvent.create({
    data: {
      matchId: match.id,
      handId: hand.id,
      type: "hand.dealt",
      stateVersion: match.stateVersion,
      publicPayload: { handNumber: hand.number, dealerPlayerId: buttonId },
      player1Payload: { yourCards: player1Cards.map(formatCard), opponentCardCount: 5 },
      player2Payload: { yourCards: player2Cards.map(formatCard), opponentCardCount: 5 },
    },
  });

  return { hand, match, matchFinished: false };
}

export interface ShowdownOutcome {
  winnerSlot: Slot | null; // null = split
  reason: HandWinReason;
  payoutPlayer1: number;
  payoutPlayer2: number;
}

/** Determina el resultado del showdown cuando ninguno se retiró. La ficha impar va al botón. */
export function resolveShowdown(hand: Hand, match: Match): ShowdownOutcome {
  const pot = hand.player1Contribution + hand.player2Contribution;
  const p1Cards = (hand.player1Cards as unknown as string[]).map(parseCard);
  const p2Cards = (hand.player2Cards as unknown as string[]).map(parseCard);
  const p1Rank = evaluateHand(p1Cards);
  const p2Rank = evaluateHand(p2Cards);
  const cmp = compareHandRank(p1Rank, p2Rank);

  if (cmp === 0) {
    const buttonSlot = slotOfPlayer(match, hand.dealerPlayerId);
    const half = Math.floor(pot / 2);
    const oddChip = pot - half * 2;
    const player1Half = buttonSlot === "player1" ? half + oddChip : half;
    const player2Half = buttonSlot === "player2" ? half + oddChip : half;
    return { winnerSlot: null, reason: "SPLIT", payoutPlayer1: player1Half, payoutPlayer2: player2Half };
  }

  const winnerSlot: Slot = cmp > 0 ? "player1" : "player2";
  return {
    winnerSlot,
    reason: "SHOWDOWN",
    payoutPlayer1: winnerSlot === "player1" ? pot : 0,
    payoutPlayer2: winnerSlot === "player2" ? pot : 0,
  };
}

export function foldOutcome(hand: Hand, folderSlot: Slot): ShowdownOutcome {
  const pot = hand.player1Contribution + hand.player2Contribution;
  const winnerSlot = otherSlot(folderSlot);
  return {
    winnerSlot,
    reason: "FOLD",
    payoutPlayer1: winnerSlot === "player1" ? pot : 0,
    payoutPlayer2: winnerSlot === "player2" ? pot : 0,
  };
}

/** Aplica el resultado de la mano: liquida fichas, marca HAND_FINISHED y decide si continuar. */
export async function finishHand(
  tx: Tx,
  match: Match,
  hand: Hand,
  outcome: ShowdownOutcome,
  revealCards: boolean,
): Promise<{ match: Match; hand: Hand }> {
  const winnerId =
    outcome.winnerSlot === "player1"
      ? match.player1Id
      : outcome.winnerSlot === "player2"
        ? match.player2Id
        : null;

  const updatedMatch = await tx.match.update({
    where: { id: match.id },
    data: {
      player1Stack: match.player1Stack! + outcome.payoutPlayer1,
      player2Stack: match.player2Stack! + outcome.payoutPlayer2,
      stateVersion: { increment: 1 },
    },
  });

  const revealedCards = revealCards
    ? { player1: hand.player1Cards, player2: hand.player2Cards }
    : undefined;

  const updatedHand = await tx.hand.update({
    where: { id: hand.id },
    data: {
      phase: "HAND_FINISHED",
      winnerId,
      winReason: outcome.reason,
      payoutPlayer1: outcome.payoutPlayer1,
      payoutPlayer2: outcome.payoutPlayer2,
      deckSeedRevealedAt: new Date(),
      revealedCards,
      toActPlayerId: null,
      turnExpiresAt: null,
    },
  });

  await tx.gameEvent.create({
    data: {
      matchId: match.id,
      handId: hand.id,
      type: "hand.finished",
      stateVersion: updatedMatch.stateVersion,
      publicPayload: {
        winnerId,
        reason: outcome.reason,
        payout: { player1: outcome.payoutPlayer1, player2: outcome.payoutPlayer2 },
        revealedCards: revealedCards ?? null,
        deckSeed: hand.deckSeed,
      },
    },
  });

  return { match: updatedMatch, hand: updatedHand };
}
