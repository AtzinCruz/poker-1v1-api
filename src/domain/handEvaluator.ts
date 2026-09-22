import type { Card, Rank } from "./card.js";

/**
 * Categorías de mano, de peor a mejor (orden interno ascendente).
 * El número no corresponde al "Orden" de la tabla del spec (que va de mejor=1 a peor=10);
 * `SPEC_ORDER` hace esa traducción para mostrar al usuario.
 */
export enum HandCategory {
  HighCard = 1,
  Pair = 2,
  TwoPair = 3,
  ThreeOfAKind = 4,
  Straight = 5,
  Flush = 6,
  FullHouse = 7,
  FourOfAKind = 8,
  StraightFlush = 9,
  RoyalFlush = 10,
}

export const SPEC_ORDER: Record<HandCategory, number> = {
  [HandCategory.RoyalFlush]: 1,
  [HandCategory.StraightFlush]: 2,
  [HandCategory.FourOfAKind]: 3,
  [HandCategory.FullHouse]: 4,
  [HandCategory.Flush]: 5,
  [HandCategory.Straight]: 6,
  [HandCategory.ThreeOfAKind]: 7,
  [HandCategory.TwoPair]: 8,
  [HandCategory.Pair]: 9,
  [HandCategory.HighCard]: 10,
};

export const CATEGORY_LABEL_ES: Record<HandCategory, string> = {
  [HandCategory.RoyalFlush]: "Escalera real",
  [HandCategory.StraightFlush]: "Escalera de color",
  [HandCategory.FourOfAKind]: "Póker",
  [HandCategory.FullHouse]: "Full house",
  [HandCategory.Flush]: "Color",
  [HandCategory.Straight]: "Escalera",
  [HandCategory.ThreeOfAKind]: "Trío",
  [HandCategory.TwoPair]: "Doble pareja",
  [HandCategory.Pair]: "Pareja",
  [HandCategory.HighCard]: "Carta alta",
};

export interface HandRank {
  category: HandCategory;
  /** Ranks en orden de significancia descendente, ya listos para comparar lexicográficamente. */
  tiebreakers: Rank[];
}

function countBy<T extends string | number>(items: T[]): Map<T, number> {
  const map = new Map<T, number>();
  for (const item of items) {
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return map;
}

/** Ranks ordenados desc de una escalera, o null si las 5 cartas no forman una. Soporta A-2-3-4-5 (escalera baja). */
function straightHighCard(sortedDescRanks: Rank[]): Rank | null {
  const unique = Array.from(new Set(sortedDescRanks));
  if (unique.length !== 5) return null;

  const isSequential = unique.every((r, i) => i === 0 || unique[i - 1]! - r === 1);
  if (isSequential) return unique[0]!;

  // Escalera baja: A,5,4,3,2 (el As actúa como 1)
  const wheel = [14, 5, 4, 3, 2];
  if (unique.length === 5 && wheel.every((r, i) => unique[i] === r)) {
    return 5;
  }
  return null;
}

export function evaluateHand(cards: Card[]): HandRank {
  if (cards.length !== 5) {
    throw new Error("Se requieren exactamente 5 cartas para evaluar una mano");
  }

  const ranksDesc = [...cards.map((c) => c.rank)].sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit);
  const straightHigh = straightHighCard(ranksDesc);

  const rankCounts = countBy(ranksDesc);
  // Grupos ordenados por (cantidad desc, rank desc) — define el desempate para la mayoría de categorías.
  const groups = Array.from(rankCounts.entries())
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))
    .map(([rank, count]) => ({ rank: rank as Rank, count }));

  if (straightHigh && isFlush) {
    const category = straightHigh === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
    return { category, tiebreakers: [straightHigh] };
  }

  if (groups[0]!.count === 4) {
    const kicker = groups[1]!.rank;
    return { category: HandCategory.FourOfAKind, tiebreakers: [groups[0]!.rank, kicker] };
  }

  if (groups[0]!.count === 3 && groups[1]!.count === 2) {
    return { category: HandCategory.FullHouse, tiebreakers: [groups[0]!.rank, groups[1]!.rank] };
  }

  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: ranksDesc };
  }

  if (straightHigh) {
    return { category: HandCategory.Straight, tiebreakers: [straightHigh] };
  }

  if (groups[0]!.count === 3) {
    const kickers = groups.slice(1).map((g) => g.rank);
    return { category: HandCategory.ThreeOfAKind, tiebreakers: [groups[0]!.rank, ...kickers] };
  }

  if (groups[0]!.count === 2 && groups[1]!.count === 2) {
    const [pairHigh, pairLow] = [groups[0]!.rank, groups[1]!.rank].sort((a, b) => b - a);
    const kicker = groups[2]!.rank;
    return { category: HandCategory.TwoPair, tiebreakers: [pairHigh!, pairLow!, kicker] };
  }

  if (groups[0]!.count === 2) {
    const kickers = groups.slice(1).map((g) => g.rank);
    return { category: HandCategory.Pair, tiebreakers: [groups[0]!.rank, ...kickers] };
  }

  return { category: HandCategory.HighCard, tiebreakers: ranksDesc };
}

/** Positivo si `a` gana, negativo si `b` gana, 0 si empatan por completo. */
export function compareHandRank(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
