import { describe, expect, it } from "vitest";
import { formatCard } from "../../src/domain/card.js";
import { commitSeed, generateSeed, orderedDeck, shuffleWithSeed } from "../../src/domain/deck.js";

describe("deck", () => {
  it("tiene 52 cartas únicas en orden canónico", () => {
    const deck = orderedDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(formatCard)).size).toBe(52);
  });

  it("genera semillas distintas cada vez", () => {
    expect(generateSeed()).not.toBe(generateSeed());
  });

  it("el shuffle es determinista para una misma semilla (verificable con commit/reveal)", () => {
    const seed = generateSeed();
    const a = shuffleWithSeed(seed).map(formatCard);
    const b = shuffleWithSeed(seed).map(formatCard);
    expect(a).toEqual(b);
  });

  it("produce 52 cartas únicas tras barajar", () => {
    const seed = generateSeed();
    const shuffled = shuffleWithSeed(seed).map(formatCard);
    expect(new Set(shuffled).size).toBe(52);
  });

  it("distintas semillas producen órdenes distintos", () => {
    const a = shuffleWithSeed(generateSeed()).map(formatCard);
    const b = shuffleWithSeed(generateSeed()).map(formatCard);
    expect(a).not.toEqual(b);
  });

  it("el commitment es determinista y no reversible a simple vista", () => {
    const seed = generateSeed();
    expect(commitSeed(seed)).toBe(commitSeed(seed));
    expect(commitSeed(seed)).not.toBe(seed);
  });
});
