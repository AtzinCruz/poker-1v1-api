import type { Hand, Match, Prisma } from "@prisma/client";
import { formatCard } from "../domain/card.js";
import { shuffleWithSeed } from "../domain/deck.js";
import { DomainError } from "../domain/errors.js";
import { logEvent } from "./events.js";
import { playerIdOfSlot, readSlot, slotUpdate, type Slot } from "./seats.js";

type Tx = Prisma.TransactionClient;

export function validateDiscardIndexes(indexes: number[], maxDiscard: number): void {
  if (indexes.length > maxDiscard) {
    throw new DomainError("INVALID_ACTION", `Solo se pueden descartar hasta ${maxDiscard} cartas`);
  }
  if (new Set(indexes).size !== indexes.length) {
    throw new DomainError("INVALID_ACTION", "Los índices a descartar no pueden repetirse");
  }
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i > 4) {
      throw new DomainError("INVALID_ACTION", "Los índices a descartar deben estar entre 0 y 4 (5 cartas privadas)");
    }
  }
}

/**
 * Reemplaza las cartas descartadas tomando las siguientes del mazo ya barajado (seed comprometida al
 * repartir). Guarda cuántas cambió y deja el evento §7 `draw.completed` (público: cuántas, nunca
 * cuáles), sea un draw del jugador o el automático por tiempo (AUD-08, AUD-10).
 */
export async function applyDraw(
  tx: Tx,
  match: Match,
  hand: Hand,
  slot: Slot,
  discardedIndexes: number[],
  options: { auto?: boolean } = {},
): Promise<Hand> {
  const view = readSlot(hand, slot);
  if (view.discarded) {
    throw new DomainError("INVALID_ACTION", "Este jugador ya hizo su draw en esta mano");
  }
  validateDiscardIndexes(discardedIndexes, match.maxDiscard);

  const fullDeck = shuffleWithSeed(hand.deckSeed);
  const newCards = [...view.cards];
  let cursor = hand.deckCursor;
  for (const idx of discardedIndexes) {
    newCards[idx] = formatCard(fullDeck[cursor]!);
    cursor += 1;
  }

  const updated = await tx.hand.update({
    where: { id: hand.id },
    data: {
      deckCursor: cursor,
      ...slotUpdate(slot, { discarded: true, discardedCount: discardedIndexes.length, cards: newCards }),
    },
  });
  await logEvent(tx, {
    matchId: match.id,
    handId: hand.id,
    type: "draw.completed",
    stateVersion: match.stateVersion,
    publicPayload: { playerId: playerIdOfSlot(match, slot), discardedCount: discardedIndexes.length, auto: options.auto ?? false },
  });
  return updated;
}

/** Todo cambio de estado visible para el cliente (incluido un draw) debe subir stateVersion, o actionVersion no protege nada. */
export async function bumpStateVersion(tx: Tx, match: Match): Promise<Match> {
  return tx.match.update({ where: { id: match.id }, data: { stateVersion: { increment: 1 } } });
}
