import { describe, expect, it } from "vitest";
import { blindIncrementFor, blindsForHand, nextBlindIncreaseHand } from "../../src/domain/blinds.js";

const incremental = { smallBlind: 10, bigBlind: 20, blindIncrement: 15, blindLevelHands: 3 };
const fixed = { ...incremental, blindIncrement: 0 };

describe("ciegas incrementales", () => {
  it("el incremento es el 5 % del stack inicial, redondeado hacia abajo", () => {
    expect(blindIncrementFor(300)).toBe(15);
    expect(blindIncrementFor(1000)).toBe(50);
    expect(blindIncrementFor(94)).toBe(4); // 4,7 → 4
    expect(blindIncrementFor(119)).toBe(5); // 5,95 → 5
  });

  it("cada 3 manos ambas ciegas suben lo mismo", () => {
    expect([1, 2, 3].map((n) => blindsForHand(incremental, n))).toEqual(Array(3).fill({ small: 10, big: 20, level: 0 }));
    expect(blindsForHand(incremental, 4)).toEqual({ small: 25, big: 35, level: 1 });
    expect(blindsForHand(incremental, 6)).toEqual({ small: 25, big: 35, level: 1 });
    expect(blindsForHand(incremental, 7)).toEqual({ small: 40, big: 50, level: 2 });
  });

  it("dice en qué mano suben; con ciegas fijas no suben nunca", () => {
    expect(nextBlindIncreaseHand(incremental, 1)).toBe(4);
    expect(nextBlindIncreaseHand(incremental, 4)).toBe(7);
    expect(blindsForHand(fixed, 40)).toEqual({ small: 10, big: 20, level: 0 });
    expect(nextBlindIncreaseHand(fixed, 1)).toBeNull();
  });
});
