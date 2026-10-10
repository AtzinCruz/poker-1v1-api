import type { Hand, Match, Prisma } from "@prisma/client";
import { DomainError } from "../domain/errors.js";
import { blindsForHand, nextBlindIncreaseHand } from "../domain/blinds.js";
import type { HandWinReason } from "../domain/types.js";
import { legalActionsFor, type LegalActionView } from "./bettingRound.js";
import { getMatchStack, otherSlot, readSlot, slotOfPlayer, type Slot } from "./seats.js";
import { prisma } from "../infrastructure/prisma/client.js";
import { runTransaction } from "../infrastructure/prisma/transaction.js";
import { resolveExpiredTurns } from "./timeouts.js";
import { lockAndLoadMatch } from "./locks.js";

type Tx = Prisma.TransactionClient | typeof prisma;

export type { LegalActionView };

export interface MatchView {
  id: string;
  status: Match["status"];
  handNumber: number;
  phase: Hand["phase"] | null;
  stateVersion: number;
  pot: number;
  /**
   * sha256 de la semilla de la mano en curso, publicado desde el reparto (AUD-07). La semilla se
   * revela al terminar la partida (auditoría de cada mano): el cliente puede comprobar que coincide.
   */
  deckCommitment: string | null;
  you: { playerId: string; stack: number; cards: string[]; contribution: number };
  opponent: {
    playerId: string;
    displayName: string | null;
    stack: number;
    cardCount: number;
    /** Cuántas cartas cambió en el draw de esta mano (público, §7 draw.completed); null si aún no lo hizo. */
    discardedCount: number | null;
    cards?: string[];
    contribution: number;
  } | null;
  turn: { playerId: string; expiresAt: string } | null;
  legalActions: LegalActionView[];
  /** Resultado de la última mano terminada (§7 hand.finished), también la que cerró la partida (AUD-13). */
  lastHand: LastHandView | null;
  finishReason?: string | null;
  winnerId?: string | null;
  /** Solo en partidas terminadas: la revancha pedida desde esta partida, si existe. */
  rematch?: RematchView | null;
  /** smallBlind/bigBlind son las del primer nivel; con blindIncrement > 0 suben cada blindLevelHands manos. */
  rules: {
    startingStack: number;
    smallBlind: number;
    bigBlind: number;
    turnTimeoutSeconds: number;
    maxDiscard: number;
    blindIncrement: number;
    blindLevelHands: number;
  };
  /** Ciegas de la mano en curso (o de la primera, si aún no empezó) y cuándo suben. */
  blinds: { small: number; big: number; level: number; nextIncreaseAtHand: number | null };
}

export interface LastHandView {
  number: number;
  /** null en un empate (SPLIT). */
  winnerId: string | null;
  winReason: HandWinReason;
  pot: number;
  payout: { you: number; opponent: number };
  /** Fichas netas de la mano para quien consulta: lo que recibió del pozo menos lo que puso. */
  net: number;
  /** Quién se retiró (FOLD), o null. */
  folderId: string | null;
  /** true si ese retiro lo aplicó el servidor porque se le acabó el tiempo. */
  timedOut: boolean;
  /** Solo si hubo showdown: las dos manos finales. */
  revealedCards?: { you: string[]; opponent: string[] };
}

export interface RematchView {
  matchId: string;
  status: Match["status"];
  /** true si la pidió quien consulta; false si la pidió el rival (y puede aceptarla). */
  requestedByYou: boolean;
}

function lastHandView(match: Match, hand: Hand, slot: Slot): LastHandView {
  const opponent = otherSlot(slot);
  const payoutOf = (s: Slot) => (s === "player1" ? hand.payoutPlayer1 : hand.payoutPlayer2) ?? 0;
  const contributionOf = (s: Slot) => (s === "player1" ? hand.player1Contribution : hand.player2Contribution);
  const revealed = hand.revealedCards as { player1: string[]; player2: string[] } | null;
  return {
    number: hand.number,
    winnerId: hand.winnerId,
    winReason: hand.winReason as HandWinReason,
    pot: hand.player1Contribution + hand.player2Contribution,
    payout: { you: payoutOf(slot), opponent: payoutOf(opponent) },
    net: payoutOf(slot) - contributionOf(slot),
    folderId: hand.player1Folded ? match.player1Id : hand.player2Folded ? match.player2Id : null,
    timedOut: hand.foldedByTimeout,
    ...(revealed && hand.winReason !== "FOLD" ? { revealedCards: { you: revealed[slot], opponent: revealed[opponent] } } : {}),
  };
}

export interface MatchViewOptions {
  opponentName?: string | null;
  rematch?: Pick<Match, "id" | "status" | "player1Id"> | null;
  /** Mano anterior a la actual: de ahí sale `lastHand` mientras la actual sigue en juego. */
  previousHand?: Hand | null;
}

export function buildMatchView(match: Match, hand: Hand | null, playerId: string, options: MatchViewOptions = {}): MatchView {
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
  const finishedHand = hand?.phase === "HAND_FINISHED" ? hand : options.previousHand?.phase === "HAND_FINISHED" ? options.previousHand : null;

  return {
    id: match.id,
    status: match.status,
    handNumber: match.handNumber,
    phase: hand?.phase ?? null,
    stateVersion: match.stateVersion,
    pot: hand ? hand.player1Contribution + hand.player2Contribution : 0,
    deckCommitment: hand?.deckCommitment ?? null,
    you: {
      playerId,
      stack: youStack,
      cards: youView?.cards ?? [],
      contribution: youView?.contribution ?? 0,
    },
    opponent: opponentId
      ? {
          playerId: opponentId,
          displayName: options.opponentName ?? null,
          stack: opponentStack,
          cardCount: opponentView?.cards.length ?? 0,
          discardedCount: opponentView?.discardedCount ?? null,
          ...(showdownRevealed ? { cards: opponentView?.cards ?? [] } : {}),
          contribution: opponentView?.contribution ?? 0,
        }
      : null,
    turn: hand?.toActPlayerId && hand.turnExpiresAt ? { playerId: hand.toActPlayerId, expiresAt: hand.turnExpiresAt.toISOString() } : null,
    legalActions: legalActionsFor(match, hand, playerId),
    lastHand: finishedHand ? lastHandView(match, finishedHand, slot) : null,
    finishReason: match.finishReason,
    winnerId: match.winnerId,
    rules: {
      startingStack: match.startingStack,
      smallBlind: match.smallBlind,
      bigBlind: match.bigBlind,
      turnTimeoutSeconds: match.turnTimeoutSeconds,
      maxDiscard: match.maxDiscard,
      blindIncrement: match.blindIncrement,
      blindLevelHands: match.blindLevelHands,
    },
    blinds: {
      ...blindsForHand(match, Math.max(1, match.handNumber)),
      nextIncreaseAtHand: nextBlindIncreaseHand(match, Math.max(1, match.handNumber)),
    },
    rematch:
      match.status === "MATCH_FINISHED" && options.rematch
        ? { matchId: options.rematch.id, status: options.rematch.status, requestedByYou: options.rematch.player1Id === playerId }
        : null,
  };
}

/** La mano anterior a la actual (para `lastHand`), o null en la primera. */
export async function previousHandOf(tx: Tx, match: Pick<Match, "id" | "handNumber">): Promise<Hand | null> {
  return match.handNumber > 1
    ? tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber - 1 } } })
    : null;
}

/** La mano actual y la anterior en una sola consulta (la ruta caliente no suma idas y vueltas). */
async function currentAndPreviousHand(tx: Tx, match: Pick<Match, "id" | "handNumber">): Promise<{ hand: Hand | null; previousHand: Hand | null }> {
  if (match.handNumber === 0) return { hand: null, previousHand: null };
  const hands = await tx.hand.findMany({ where: { matchId: match.id, number: { in: [match.handNumber, match.handNumber - 1] } } });
  return {
    hand: hands.find((h) => h.number === match.handNumber) ?? null,
    previousHand: hands.find((h) => h.number === match.handNumber - 1) ?? null,
  };
}

const PLAYER_NAMES = {
  player1: { select: { displayName: true } },
  player2: { select: { displayName: true } },
  // Mismo JOIN: la revancha (si la hay) para que la mesa terminada pueda ofrecerla o aceptarla.
  rematch: { select: { id: true, status: true, player1Id: true } },
} as const;

/** GET /matches/{id}: resuelve timeouts vencidos y arma la vista filtrada para `playerId`. */
export async function getMatchViewForPlayer(matchId: string, playerId: string): Promise<MatchView> {
  // Camino rápido (casi todos los polls): lectura consistente con un snapshot, SIN bloquear la partida.
  // RepeatableRead evita ver una mano a medio actualizar respecto a la partida.
  const snapshot = await runTransaction(
    async (tx) => {
      // Los nombres vienen en la misma consulta (JOIN): mostrar al rival no agrega idas y vueltas.
      const found = await tx.match.findUnique({ where: { id: matchId }, include: PLAYER_NAMES });
      if (!found) {
        throw new DomainError("MATCH_NOT_FOUND", "La partida no existe o no es visible");
      }
      const { player1, player2, rematch, ...match } = found;
      if (playerId !== match.player1Id && playerId !== match.player2Id) {
        throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
      }
      const { hand, previousHand } = await currentAndPreviousHand(tx, match);
      const opponentName = playerId === match.player1Id ? (player2?.displayName ?? null) : player1.displayName;
      return { match, hand, previousHand, opponentName, rematch: rematch ?? null };
    },
    { isolationLevel: "RepeatableRead" },
  );

  const turnExpired =
    snapshot.match.status === "IN_PROGRESS" &&
    snapshot.hand?.turnExpiresAt != null &&
    snapshot.hand.turnExpiresAt.getTime() <= Date.now();
  if (!turnExpired) {
    return buildMatchView(snapshot.match, snapshot.hand, playerId, {
      opponentName: snapshot.opponentName,
      rematch: snapshot.rematch,
      previousHand: snapshot.previousHand,
    });
  }

  // Camino lento: hay un turno vencido que esta lectura debe resolver, así que se serializa igual que
  // un comando (lock + relectura, porque el estado pudo cambiar entre el snapshot y el lock).
  return runTransaction(async (tx) => {
    const match = await lockAndLoadMatch(tx, matchId);
    if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe o no es visible");
    const hand = match.handNumber > 0
      ? await tx.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } })
      : null;
    const resolved = await resolveExpiredTurns(tx, match, hand);
    // Los nombres no cambian y este camino solo ocurre con la partida en curso (rival ya asignado).
    return buildMatchView(resolved.match, resolved.hand, playerId, {
      opponentName: snapshot.opponentName,
      previousHand: await previousHandOf(tx, resolved.match),
    });
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
  /** Se revela al terminar la PARTIDA (AUD-03); hasta entonces null. sha256(deckSeed) === deckCommitment. */
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
    include: { actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, match: true },
  });
  if (!hand) {
    throw new DomainError("MATCH_NOT_FOUND", "No existe esa mano para esta partida");
  }
  if (hand.phase !== "HAND_FINISHED") {
    throw new DomainError("INVALID_ACTION", "La mano todavía no terminó; no hay auditoría disponible");
  }

  // Con la semilla y los descartes se rearman las manos finales de ambos, también la que se retiró
  // sin mostrarse: mientras la partida siga, no se publica (las manos ya terminadas antes de este
  // cambio tienen deckSeedRevealedAt, por eso se mira también el estado de la partida).
  const seedRevealed = hand.match.status === "MATCH_FINISHED" && hand.deckSeedRevealedAt !== null;

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
    deckSeed: seedRevealed ? hand.deckSeed : null,
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
