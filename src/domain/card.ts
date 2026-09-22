export type Suit = "S" | "H" | "D" | "C";

/** 2-10, J=11, Q=12, K=13, A=14 (el As siempre alto en Five-Card Draw). */
export type Rank =
  | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

const RANK_CHARS: Record<Rank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A",
};

const CHAR_TO_RANK: Record<string, Rank> = Object.fromEntries(
  (Object.entries(RANK_CHARS) as [string, string][]).map(([rank, ch]) => [ch, Number(rank) as Rank]),
);

export const SUITS: Suit[] = ["S", "H", "D", "C"];
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** Formatea una carta como "AS", "KD", "10H" (los ejemplos del spec usan "10H" para el diez). */
export function formatCard(card: Card): string {
  return `${RANK_CHARS[card.rank]}${card.suit}`;
}

export function parseCard(text: string): Card {
  const suit = text.slice(-1) as Suit;
  const rankPart = text.slice(0, -1);
  const rank = CHAR_TO_RANK[rankPart];
  if (!rank || !SUITS.includes(suit)) {
    throw new Error(`Carta inválida: ${text}`);
  }
  return { rank, suit };
}

export function cardsEqual(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}
