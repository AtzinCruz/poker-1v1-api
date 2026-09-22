import { describe, expect, it } from "vitest";
import { parseCard } from "../../src/domain/card.js";
import { HandCategory, compareHandRank, evaluateHand } from "../../src/domain/handEvaluator.js";

function hand(cards: string): ReturnType<typeof evaluateHand> {
  return evaluateHand(cards.split(",").map(parseCard));
}

describe("evaluateHand", () => {
  it("reconoce escalera real", () => {
    expect(hand("AS,KS,QS,JS,10S").category).toBe(HandCategory.RoyalFlush);
  });

  it("reconoce escalera de color", () => {
    expect(hand("9H,8H,7H,6H,5H").category).toBe(HandCategory.StraightFlush);
  });

  it("reconoce póker (four of a kind) con kicker", () => {
    const r = hand("QC,QD,QH,QS,4C");
    expect(r.category).toBe(HandCategory.FourOfAKind);
    expect(r.tiebreakers).toEqual([12, 4]);
  });

  it("reconoce full house", () => {
    const r = hand("JC,JD,JH,8S,8C");
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreakers).toEqual([11, 8]);
  });

  it("reconoce color (flush)", () => {
    expect(hand("AC,JC,8C,5C,2C").category).toBe(HandCategory.Flush);
  });

  it("reconoce escalera", () => {
    expect(hand("10C,9D,8H,7S,6C").category).toBe(HandCategory.Straight);
  });

  it("reconoce escalera baja (rueda) A-2-3-4-5", () => {
    const r = hand("AC,2D,3H,4S,5C");
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreakers).toEqual([5]);
  });

  it("reconoce trío", () => {
    const r = hand("7C,7D,7H,KS,3C");
    expect(r.category).toBe(HandCategory.ThreeOfAKind);
  });

  it("reconoce doble pareja", () => {
    const r = hand("AC,AD,10H,10S,4C");
    expect(r.category).toBe(HandCategory.TwoPair);
    expect(r.tiebreakers).toEqual([14, 10, 4]);
  });

  it("reconoce pareja", () => {
    expect(hand("KC,KD,QH,8S,3C").category).toBe(HandCategory.Pair);
  });

  it("reconoce carta alta", () => {
    expect(hand("AC,JD,8H,5S,2C").category).toBe(HandCategory.HighCard);
  });

  it("no confunde una casi-escalera con escalera", () => {
    expect(hand("10C,9D,8H,7S,5C").category).toBe(HandCategory.HighCard);
  });
});

describe("compareHandRank", () => {
  it("una categoría superior siempre gana, sin importar los kickers", () => {
    const pair = hand("AC,AD,KH,QS,JC");
    const straight = hand("2C,3D,4H,5S,6C");
    expect(compareHandRank(straight, pair)).toBeGreaterThan(0);
  });

  it("desempata por carta principal y luego kickers", () => {
    const a = hand("KC,KD,9H,7S,2C");
    const b = hand("KC,KD,9H,6S,3C");
    expect(compareHandRank(a, b)).toBeGreaterThan(0);
  });

  it("manos idénticas empatan", () => {
    const a = hand("AC,JD,8H,5S,2C");
    const b = hand("AH,JS,8C,5D,2H");
    expect(compareHandRank(a, b)).toBe(0);
  });
});
