/**
 * Utilidades independientes del código auditado: PRNG con semilla (reproducible) y un evaluador de
 * manos de referencia escrito desde cero (máscara de bits para escaleras), para cruzar resultados.
 */
import type { Card } from "../../src/domain/card.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
export const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

/** Categorías de referencia: 8 = escalera de color (la real es la de as alto), …, 0 = carta alta. */
export function referenceScore(cards: Card[]): number[] {
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranksDesc = cards.map((c) => c.rank as number).sort((a, b) => b - a);
  const flush = new Set(cards.map((c) => c.suit)).size === 1;

  let straightHigh = 0;
  if (counts.size === 5) {
    let mask = 0;
    for (const r of counts.keys()) mask |= 1 << r;
    if (mask & (1 << 14)) mask |= 1 << 1; // el as también vale 1
    for (let high = 14; high >= 5; high--) {
      const run = 0b11111 << (high - 4);
      if ((mask & run) === run) {
        straightHigh = high;
        break;
      }
    }
  }

  const shape = groups.map((g) => g[1]).join("");
  const byGroup = groups.map((g) => g[0]);
  if (straightHigh && flush) return [8, straightHigh];
  if (shape === "41") return [7, ...byGroup];
  if (shape === "32") return [6, ...byGroup];
  if (flush) return [5, ...ranksDesc];
  if (straightHigh) return [4, straightHigh];
  if (shape === "311") return [3, ...byGroup];
  if (shape === "221") return [2, ...byGroup];
  if (shape === "2111") return [1, ...byGroup];
  return [0, ...ranksDesc];
}

export function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
