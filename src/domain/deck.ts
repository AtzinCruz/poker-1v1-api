import { createHash, randomBytes } from "node:crypto";
import type { Card } from "./card.js";
import { RANKS, SUITS } from "./card.js";

/** Mazo estándar de 52 cartas en orden canónico (antes de barajar). */
export function orderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** Semilla criptográficamente aleatoria (CSPRNG del servidor, nunca Math.random). */
export function generateSeed(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compromiso (hash) de la semilla, publicable antes de revelar la semilla en sí.
 * Permite auditar después de la mano que el barajado no se manipuló a posteriori.
 */
export function commitSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * Flujo de bytes pseudoaleatorio determinista derivado de la semilla, usado únicamente
 * para reproducir el shuffle de forma verificable (no para generar la propia semilla).
 */
function seededUint32(seed: string, counter: number): number {
  const digest = createHash("sha256").update(`${seed}:${counter}`).digest();
  return digest.readUInt32BE(0);
}

/**
 * Fisher-Yates determinista a partir de una semilla ya generada con CSPRNG.
 * Dado el mismo `seed`, siempre produce el mismo orden — así el `deckCommitment`
 * publicado antes de la mano puede verificarse revelando la `seed` al terminar.
 */
export function shuffleWithSeed(seed: string): Card[] {
  const deck = orderedDeck();
  let counter = 0;
  for (let i = deck.length - 1; i > 0; i--) {
    // Rechazo de sesgo de módulo: descarta valores fuera del rango uniforme.
    const range = i + 1;
    const limit = Math.floor(0xffffffff / range) * range;
    let random: number;
    do {
      random = seededUint32(seed, counter++);
    } while (random >= limit);
    const j = random % range;
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }
  return deck;
}
