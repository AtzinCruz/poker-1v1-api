/**
 * Propiedades del dominio puro (sin BD), con PRNG de semilla fija para que cualquier fallo se repita:
 *  - motor de apuestas: conservación de fichas, cierre con aportaciones igualadas y
 *    `legalBettingActions` ⇔ lo que el motor acepta;
 *  - evaluador: mismo veredicto que un evaluador de referencia independiente;
 *  - barajado: distribución uniforme carta × posición.
 */
import { describe, expect, it } from "vitest";
import {
  applyAllIn,
  applyCheckOrBet,
  createBettingRound,
  legalBettingActions,
  type BettingRoundResult,
  type BettingRoundState,
  type Seat,
} from "../../src/domain/bettingEngine.js";
import { DomainError } from "../../src/domain/errors.js";
import { compareHandRank, evaluateHand, HandCategory } from "../../src/domain/handEvaluator.js";
import { orderedDeck, shuffleWithSeed } from "../../src/domain/deck.js";
import { formatCard } from "../../src/domain/card.js";
import { compareScores, mulberry32, pick, randInt, referenceScore } from "./reference.js";

const ROUNDS = Number(process.env.FUZZ_ENGINE_ROUNDS ?? 20_000);

type Move = { kind: "BET"; amount: number } | { kind: "ALL_IN" };

function apply(state: BettingRoundState, seat: Seat, move: Move): BettingRoundResult {
  return move.kind === "ALL_IN" ? applyAllIn(state, seat) : applyCheckOrBet(state, seat, move.amount);
}

/** ¿El movimiento figura entre las acciones legales anunciadas al cliente? */
function isAdvertised(state: BettingRoundState, seat: Seat, move: Move): boolean {
  const legal = legalBettingActions(state, seat);
  if (move.kind === "ALL_IN") return legal.some((a) => a.type === "ALL_IN");
  const max = state.stacks[seat] + state.contributions[seat];
  return legal.some(
    (a) =>
      (a.type === "CHECK" && move.amount === 0) ||
      // BET 0 o BET por lo ya puesto equivalen a check cuando no hay nada pendiente.
      (a.type === "CHECK" && move.amount === state.contributions[seat] && move.amount === state.currentBet) ||
      (a.type === "CALL" && move.amount === a.amount) ||
      (a.type === "RAISE" && move.amount >= a.min && move.amount <= a.max) ||
      // BET por todo el stack equivale a ALL_IN solo si llega a la apuesta actual (si no, hay que mandar ALL_IN).
      (a.type === "ALL_IN" && move.amount === max && move.amount >= state.currentBet),
  );
}

describe("motor de apuestas: propiedades", () => {
  it(`${ROUNDS} rondas aleatorias conservan fichas y anuncian exactamente lo que aceptan`, () => {
    const rnd = mulberry32(0xc0ffee);
    const violations: string[] = [];

    for (let round = 0; round < ROUNDS && violations.length < 20; round++) {
      const bb = pick(rnd, [2, 10, 20, 50]);
      const sb = Math.max(1, Math.floor(bb / 2));
      const preDraw = rnd() < 0.5;
      const stacks: [number, number] = [randInt(rnd, bb, bb * 30), randInt(rnd, bb, bb * 30)];
      // Pre-draw: el botón (asiento 0) puso la chica y el otro la grande. Post-draw: ronda vacía.
      const contributions: [number, number] = preDraw ? [sb, bb] : [0, 0];
      let state = createBettingRound({
        stacks: [stacks[0] - contributions[0], stacks[1] - contributions[1]],
        contributions,
        currentBet: preDraw ? bb : 0,
        lastRaiseSize: bb,
        toAct: 0,
      });
      if (state.allIn[0]) state = { ...state, toAct: 1 };
      const totals = [stacks[0], stacks[1]];

      for (let step = 0; step < 40; step++) {
        const seat = state.toAct;
        const max = state.stacks[seat] + state.contributions[seat];
        const move: Move =
          rnd() < 0.15
            ? { kind: "ALL_IN" }
            : {
                kind: "BET",
                amount: pick(rnd, [
                  0,
                  state.currentBet,
                  state.currentBet + state.lastRaiseSize,
                  state.currentBet + state.lastRaiseSize - 1,
                  randInt(rnd, 0, max),
                  max,
                  max + 1,
                ]),
              };
        const advertised = isAdvertised(state, seat, move);
        let result: BettingRoundResult | null = null;
        try {
          result = apply(state, seat, move);
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
        }
        const ctx = `ronda ${round} paso ${step} ${JSON.stringify({ state, seat, move })}`;
        if (advertised && !result) violations.push(`anunciada pero rechazada: ${ctx}`);
        if (!advertised && result) violations.push(`aceptada sin anunciarse: ${ctx}`);
        if (!result) {
          // Un movimiento rechazado no puede dejar al jugador sin salida: siempre hay FOLD y algo más.
          if (legalBettingActions(state, seat).length < 2) violations.push(`sin acciones: ${ctx}`);
          continue;
        }
        const s = result.state;
        for (const k of [0, 1] as const) {
          if (s.stacks[k] + s.contributions[k] !== totals[k]) violations.push(`fichas no conservadas: ${ctx}`);
          if (s.stacks[k] < 0 || s.contributions[k] < 0) violations.push(`negativo: ${ctx}`);
          if (s.stacks[k] === 0 && !s.allIn[k]) violations.push(`sin fichas y no all-in: ${ctx}`);
          // Tras devolver el excedente, el que más puso conserva allIn=true con fichas: inocuo solo si el rival
          // también está all-in (no queda ninguna decisión de apuesta).
          if (s.allIn[k] && s.stacks[k] > 0 && !s.allIn[k === 0 ? 1 : 0]) violations.push(`allIn con fichas: ${ctx}`);
        }
        if (result.closed) {
          if (s.contributions[0] !== s.contributions[1]) violations.push(`cierra sin igualar: ${ctx}`);
          break;
        }
        if (s.allIn[s.toAct]) violations.push(`turno a un jugador all-in: ${ctx}`);
        state = s;
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("evaluador de manos frente a una referencia independiente", () => {
  it("coincide en 200 000 duelos aleatorios", () => {
    const rnd = mulberry32(42);
    const deck = orderedDeck();
    const mismatches: string[] = [];
    for (let i = 0; i < 200_000 && mismatches.length < 10; i++) {
      const idx = new Set<number>();
      while (idx.size < 10) idx.add(Math.floor(rnd() * 52));
      const cards = [...idx].map((k) => deck[k]!);
      const a = cards.slice(0, 5);
      const b = cards.slice(5);
      const got = Math.sign(compareHandRank(evaluateHand(a), evaluateHand(b)));
      const want = Math.sign(compareScores(referenceScore(a), referenceScore(b)));
      if (got !== want) mismatches.push(`${a.map(formatCard)} vs ${b.map(formatCard)}: ${got} ≠ ${want}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("casos límite: rueda, escalera real, kickers de doble pareja y empates exactos", () => {
    const h = (s: string) =>
      s.split(" ").map((t) => ({ rank: ({ A: 14, K: 13, Q: 12, J: 11, T: 10 } as Record<string, number>)[t[0]!] ?? Number(t[0]), suit: t[1] }) as never);
    const cmp = (x: string, y: string) => Math.sign(compareHandRank(evaluateHand(h(x)), evaluateHand(h(y))));
    expect(evaluateHand(h("AS 2D 3C 4H 5S")).category).toBe(HandCategory.Straight);
    expect(cmp("AS 2D 3C 4H 5S", "6S 2D 3C 4H 5D")).toBe(-1); // la rueda pierde contra 6 alto
    expect(cmp("AS 2S 3S 4S 5S", "KD QD JD TD 9D")).toBe(-1); // escalera de color baja < K alta
    expect(evaluateHand(h("AH KH QH JH TH")).category).toBe(HandCategory.RoyalFlush);
    expect(cmp("KS KD 4C 4H 9S", "KH KC 4D 4S 8S")).toBe(1); // mismo par doble, gana el kicker
    expect(cmp("AS KD 9C 7H 3S", "AH KC 9D 7S 3D")).toBe(0); // empate exacto → pozo dividido
    expect(cmp("AS AD 2C 2H 3S", "KH KC QD QS JD")).toBe(1);
    expect(cmp("2S 2D 2C AH KS", "3H 3C 3D 4S 5S")).toBe(-1);
  });
});

describe("barajado", () => {
  it("cada carta cae en cada posición con frecuencia uniforme (χ² sobre 52×52)", () => {
    const N = 40_000;
    const counts = Array.from({ length: 52 }, () => new Array<number>(52).fill(0));
    const index = new Map(orderedDeck().map((c, i) => [formatCard(c), i]));
    for (let s = 0; s < N; s++) {
      const shuffled = shuffleWithSeed(`audit-seed-${s}`);
      shuffled.forEach((c, pos) => counts[pos]![index.get(formatCard(c))!]! += 1);
    }
    const expected = N / 52;
    let chi2 = 0;
    for (const row of counts) for (const o of row) chi2 += (o - expected) ** 2 / expected;
    const df = 51 * 51;
    // Media df, desviación √(2·df): 6σ por encima sería un sesgo claro.
    expect(chi2).toBeLessThan(df + 6 * Math.sqrt(2 * df));
  });
});
