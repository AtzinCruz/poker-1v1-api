import type { Hand, Match, Prisma } from "@prisma/client";
import { legalBettingActions, type LegalBettingAction } from "../domain/bettingEngine.js";
import { DomainError } from "../domain/errors.js";
import { toEngineState, slotToSeat, buttonSlot } from "./bettingRound.js";
import { getMatchStack, otherSlot, readSlot, slotOfPlayer, type Slot } from "./seats.js";
import { prisma } from "../infrastructure/prisma/client.js";
import { resolveExpiredTurns } from "./timeouts.js";

type Tx = Prisma.TransactionClient | typeof prisma;

export type LegalActionView =
  | { type: "DRAW"; minDiscard: number; maxDiscard: number }
  | LegalBettingAction;

export interface MatchView {
  id: string;
  status: Match["status"];
  handNumber: number;
  phase: Hand["phase"] | null;
  stateVersion: number;
  pot: number;
  you: { playerId: string; stack: number; cards: string[]; contribution: number };
  opponent: { playerId: string; stack: number; cardCount: number; cards?: string[]; contribution: number } | null;
  turn: { playerId: string; expiresAt: string } | null;
  legalActions: LegalActionView[];
  finishReason?: string | null;
  winnerId?: string | null;
}

function legalActionsFor(match: Match, hand: Hand | null, playerId: string, slot: Slot): LegalActionView[] {
  if (!hand || hand.toActPlayerId !== playerId) return [];

  if (hand.phase === "DRAW") {
    return [{ type: "DRAW", minDiscard: 0, maxDiscard: match.maxDiscard }];
  }

  if (hand.phase === "BETTING_PRE_DRAW" || hand.phase === "BETTING_POST_DRAW") {
    const state = toEngineState(match, hand);
    const button = buttonSlot(match, hand);
    const seat = slotToSeat(button, slot);
    return legalBettingActions(state, seat);
  }

  return [];
}

export function buildMatchView(match: Match, hand: Hand | null, playerId: string): MatchView {
  const slot = slotOfPlayer(match, playerId);
  const opponentSlot = otherSlot(slot);
  const opponentId = opponentSlot === "player1" ? match.player1Id : match.player2Id;

  const youStack = match.player1Stack !== null && match.player2Stack !== null ? getMatchStack(match, slot) : 0;
  const opponentStack =
    opponentId && match.player1Stack !== null && match.player2Stack !== null
      ? getMatchStack(match, opponentSlot)
      : 0;

  const youView = hand ? readSlot(hand, slot) : null;
  const opponentView = hand ? readSlot(hand, opponentSlot) : null;

  const showdownRevealed = hand?.phase === "HAND_FINISHED" && hand.revealedCards !== null && hand.winReason !== "FOLD";

  return {
    id: match.id,
    status: match.status,
    handNumber: match.handNumber,
    phase: hand?.phase ?? null,
    stateVersion: match.stateVersion,
    pot: hand ? hand.player1Contribution + hand.player2Contribution : 0,
    you: {
      playerId,
      stack: youStack,
      cards: youView?.cards ?? [],
      contribution: youView?.contribution ?? 0,
    },
    opponent: opponentId
      ? {
          playerId: opponentId,
          stack: opponentStack,
          cardCount: opponentView?.cards.length ?? 0,
          ...(showdownRevealed ? { cards: opponentView?.cards ?? [] } : {}),
          contribution: opponentView?.contribution ?? 0,
        }
      : null,
    turn: hand?.toActPlayerId && hand.turnExpiresAt ? { playerId: hand.toActPlayerId, expiresAt: hand.turnExpiresAt.toISOString() } : null,
    legalActions: legalActionsFor(match, hand, playerId, slot),
    finishReason: match.finishReason,
    winnerId: match.winnerId,
  };
}

/** GET /matches/{id}: resuelve timeouts vencidos y arma la vista filtrada para `playerId`. */
export async function getMatchViewForPlayer(matchId: string, playerId: string): Promise<MatchView> {
  return prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) {
      throw new DomainError("MATCH_NOT_FOUND", "La partida no existe o no es visible");
    }
    if (playerId !== match.player1Id && playerId !== match.player2Id) {
      throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
    }
    const hand = match.handNumber > 0
      ? await tx.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } })
      : null;

    const resolved = await resolveExpiredTurns(tx, match, hand);
    return buildMatchView(resolved.match, resolved.hand, playerId);
  });
}

export interface HandSummary {
  number: number;
  phase: Hand["phase"];
  pot: number;
  winnerId: string | null;
  winReason: string | null;
  payoutPlayer1: number | null;
  payoutPlayer2: number | null;
  finishedAt: string;
}

async function assertMatchMembership(tx: Tx, matchId: string, playerId: string): Promise<void> {
  const match = await tx.match.findUnique({ where: { id: matchId } });
  if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe o no es visible");
  if (playerId !== match.player1Id && playerId !== match.player2Id) {
    throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
  }
}

export async function listHandSummaries(tx: Tx, matchId: string, playerId: string): Promise<HandSummary[]> {
  await assertMatchMembership(tx, matchId, playerId);
  const hands = await tx.hand.findMany({
    where: { matchId, phase: "HAND_FINISHED" },
    orderBy: { number: "asc" },
  });
  return hands.map((h) => ({
    number: h.number,
    phase: h.phase,
    pot: h.player1Contribution + h.player2Contribution,
    winnerId: h.winnerId,
    winReason: h.winReason,
    payoutPlayer1: h.payoutPlayer1,
    payoutPlayer2: h.payoutPlayer2,
    finishedAt: h.updatedAt.toISOString(),
  }));
}

export interface HandAudit {
  number: number;
  phase: Hand["phase"];
  dealerPlayerId: string;
  player1Id: string;
  player2Id: string;
  pot: number;
  contributions: { player1: number; player2: number };
  winnerId: string | null;
  winReason: string | null;
  payout: { player1: number | null; player2: number | null };
  revealedCards: unknown;
  deckCommitment: string;
  deckSeed: string | null;
  actions: Array<{
    playerId: string;
    type: string;
    amount: number | null;
    discardedIndexes: number[];
    isAuto: boolean;
    createdAt: string;
  }>;
}

export async function getHandAudit(tx: Tx, matchId: string, handNumber: number, playerId: string): Promise<HandAudit> {
  await assertMatchMembership(tx, matchId, playerId);
  const hand = await tx.hand.findUnique({
    where: { matchId_number: { matchId, number: handNumber } },
    include: { actions: { orderBy: { createdAt: "asc" } }, match: true },
  });
  if (!hand) {
    throw new DomainError("MATCH_NOT_FOUND", "No existe esa mano para esta partida");
  }
  if (hand.phase !== "HAND_FINISHED") {
    throw new DomainError("INVALID_ACTION", "La mano todavía no terminó; no hay auditoría disponible");
  }

  return {
    number: hand.number,
    phase: hand.phase,
    dealerPlayerId: hand.dealerPlayerId,
    player1Id: hand.match.player1Id,
    player2Id: hand.match.player2Id!,
    pot: hand.player1Contribution + hand.player2Contribution,
    contributions: { player1: hand.player1Contribution, player2: hand.player2Contribution },
    winnerId: hand.winnerId,
    winReason: hand.winReason,
    payout: { player1: hand.payoutPlayer1, player2: hand.payoutPlayer2 },
    revealedCards: hand.revealedCards,
    deckCommitment: hand.deckCommitment,
    deckSeed: hand.deckSeedRevealedAt ? hand.deckSeed : null,
    actions: hand.actions.map((a) => ({
      playerId: a.playerId,
      type: a.type,
      amount: a.amount,
      discardedIndexes: a.discardedIndexes,
      isAuto: a.isAuto,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
