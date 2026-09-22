import { describe, expect, it } from "vitest";
import {
  applyAllIn,
  applyCheckOrBet,
  createBettingRound,
  legalBettingActions,
} from "../../src/domain/bettingEngine.js";
import { DomainError } from "../../src/domain/errors.js";

/** Ronda pre-draw típica: ciegas 10/20 ya posteadas, botón (seat 0) actúa primero. */
function preDrawRound(stacks: [number, number] = [980, 980]) {
  return createBettingRound({
    stacks,
    contributions: [10, 20],
    currentBet: 20,
    lastRaiseSize: 20,
    toAct: 0,
  });
}

describe("bettingEngine: check/call/raise", () => {
  it("el botón debe igualar la ciega grande, no puede check", () => {
    const state = preDrawRound();
    expect(() => applyCheckOrBet(state, 0, 0)).toThrow(DomainError);
  });

  it("call iguala la apuesta pendiente y pasa el turno", () => {
    const state = preDrawRound();
    const result = applyCheckOrBet(state, 0, 20);
    expect(result.closed).toBe(false);
    expect(result.state.contributions).toEqual([20, 20]);
    expect(result.state.toAct).toBe(1);
  });

  it("cierra la ronda cuando ambos igualan tras un call", () => {
    const state = applyCheckOrBet(preDrawRound(), 0, 20).state;
    const result = applyCheckOrBet(state, 1, 20);
    expect(result.closed).toBe(true);
    expect(result.state.contributions).toEqual([20, 20]);
  });

  it("check-check cierra una ronda post-draw sin apuestas", () => {
    const state = createBettingRound({
      stacks: [980, 960],
      contributions: [0, 0],
      currentBet: 0,
      lastRaiseSize: 20,
      toAct: 0,
    });
    const afterCheck1 = applyCheckOrBet(state, 0, 0);
    expect(afterCheck1.closed).toBe(false);
    const afterCheck2 = applyCheckOrBet(afterCheck1.state, 1, 0);
    expect(afterCheck2.closed).toBe(true);
  });

  it("un raise por debajo del mínimo se rechaza", () => {
    const state = preDrawRound();
    expect(() => applyCheckOrBet(state, 0, 30)).toThrow(DomainError);
  });

  it("un raise válido reabre la acción para el rival", () => {
    const state = preDrawRound();
    const raised = applyCheckOrBet(state, 0, 60); // sube 40, ≥ lastRaiseSize (20)
    expect(raised.closed).toBe(false);
    expect(raised.state.currentBet).toBe(60);
    expect(raised.state.lastRaiseSize).toBe(40);
    expect(raised.state.toAct).toBe(1);
  });

  it("no se puede apostar más de lo disponible", () => {
    const state = preDrawRound([5, 980]);
    expect(() => applyCheckOrBet(state, 0, 100)).toThrow(DomainError);
  });
});

describe("bettingEngine: all-in", () => {
  it("all-in parcial que no alcanza a igualar cierra la ronda y reembolsa el excedente", () => {
    // seat1 (ciega grande) es corto de fichas: solo 40 fichas totales (20 ya posteadas + 20 de stack).
    const shortStackRound = createBettingRound({
      stacks: [980, 20],
      contributions: [10, 20],
      currentBet: 20,
      lastRaiseSize: 20,
      toAct: 0,
    });
    const raised = applyCheckOrBet(shortStackRound, 0, 100);
    expect(raised.closed).toBe(false);
    expect(raised.state.toAct).toBe(1);

    const result = applyAllIn(raised.state, 1);
    expect(result.closed).toBe(true);
    expect(result.state.allIn[1]).toBe(true);
    expect(result.state.contributions).toEqual([40, 40]);
    expect(result.refund).toEqual({ seat: 0, amount: 60 });
    expect(result.state.stacks[0]).toBe(890 + 60);
  });

  it("all-in que sube la apuesta obliga al rival a responder", () => {
    const state = preDrawRound();
    const allIn = applyAllIn(state, 0);
    expect(allIn.closed).toBe(false);
    expect(allIn.state.currentBet).toBe(990);
    expect(allIn.state.toAct).toBe(1);
  });

  it("no se puede subir a un rival que ya está all-in", () => {
    const state = createBettingRound({
      stacks: [20, 980],
      contributions: [10, 20],
      currentBet: 20,
      lastRaiseSize: 20,
      toAct: 0,
    });
    const allIn = applyAllIn(state, 0);
    expect(allIn.state.allIn[0]).toBe(true);
    expect(allIn.closed).toBe(false);
    expect(() => applyCheckOrBet(allIn.state, 1, allIn.state.currentBet + 50)).toThrow(DomainError);
  });
});

describe("legalBettingActions", () => {
  it("cuando hay apuesta pendiente ofrece CALL, RAISE, ALL_IN y FOLD, no CHECK", () => {
    const actions = legalBettingActions(preDrawRound(), 0);
    const types = actions.map((a) => a.type);
    expect(types).toContain("CALL");
    expect(types).toContain("FOLD");
    expect(types).not.toContain("CHECK");
  });

  it("sin apuesta pendiente ofrece CHECK en vez de CALL", () => {
    const state = createBettingRound({
      stacks: [980, 980],
      contributions: [0, 0],
      currentBet: 0,
      lastRaiseSize: 20,
      toAct: 0,
    });
    const types = legalBettingActions(state, 0).map((a) => a.type);
    expect(types).toContain("CHECK");
    expect(types).not.toContain("CALL");
  });

  it("no ofrece acciones a quien no tiene el turno", () => {
    expect(legalBettingActions(preDrawRound(), 1)).toEqual([]);
  });

  it("el amount de CALL es el total de la ronda (mismo formato que espera BET), no el delta", () => {
    // seat 0 ya aportó 10, currentBet es 20 → falta 10 para igualar, pero el amount a enviar
    // en BET debe ser el total (20), no el delta (10).
    const actions = legalBettingActions(preDrawRound(), 0);
    const call = actions.find((a) => a.type === "CALL");
    expect(call).toEqual({ type: "CALL", amount: 20 });
  });

  it("el rango de RAISE también son totales de ronda listos para enviar en BET", () => {
    const actions = legalBettingActions(preDrawRound(), 0);
    const raise = actions.find((a) => a.type === "RAISE");
    expect(raise).toEqual({ type: "RAISE", min: 40, max: 990 });
  });
});
