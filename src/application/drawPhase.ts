import type { Hand, Match, Prisma } from "@prisma/client";
import { formatCard } from "../domain/card.js";
import { shuffleWithSeed } from "../domain/deck.js";
import { DomainError } from "../domain/errors.js";
import { readSlot, slotUpdate, type Slot } from "./seats.js";

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

/** Reemplaza las cartas descartadas tomando las siguientes del mazo ya barajado (seed comprometida al repartir). */
export async function applyDraw(
  tx: Tx,
  match: Match,
  hand: Hand,
  slot: Slot,
  discardedIndexes: number[],
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

  return tx.hand.update({
    where: { id: hand.id },
    data: {
      deckCursor: cursor,
      ...slotUpdate(slot, { discarded: true, cards: newCards }),
    },
  });
}
