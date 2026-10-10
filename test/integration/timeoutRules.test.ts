/**
 * Regla automática del §2.4 en cada fase (regresión de AUD-23: las ramas de draw vacío y check automático
 * de timeouts.ts no tenían cobertura): DRAW → draw vacío; si se puede hacer check → check; si no → fold.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { act, bearer, expireCurrentTurn, makePlayer, startMatch, view, type AuditPlayer } from "../helpers/scenario.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function lastAction(matchId: string) {
  return prisma.action.findFirstOrThrow({ where: { matchId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

async function timeOut(matchId: string, reader: AuditPlayer) {
  await expireCurrentTurn(matchId);
  const res = await app.inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: bearer(reader) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("timeouts por fase (§2.4)", () => {
  it("pre-draw: el botón ante la ciega grande → FOLD automático", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const v = await timeOut(m, bob);
    const a = await lastAction(m);
    expect([a.playerId, a.type, a.isAuto]).toEqual([alice.id, "FOLD", true]);
    expect(v.handNumber).toBe(2);
  });

  it("pre-draw: la ciega grande con opción (sin apuesta pendiente) → CHECK automático, pasa a DRAW", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    let v = await view(app, m, alice);
    await act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion });
    v = await timeOut(m, alice);
    const a = await lastAction(m);
    expect([a.playerId, a.type, a.amount, a.isAuto]).toEqual([bob.id, "BET", 0, true]);
    expect(v.phase).toBe("DRAW");
  });

  it("DRAW: draw vacío automático (conserva las 5 cartas) y el turno pasa al rival", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    let v = await view(app, m, alice);
    await act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion });
    v = await view(app, m, bob);
    await act(app, m, bob, { type: "BET", amount: 0, actionVersion: v.stateVersion });
    const before = (await view(app, m, alice)).you.cards;
    v = await timeOut(m, alice);
    const a = await lastAction(m);
    expect([a.playerId, a.type, a.discardedIndexes, a.isAuto]).toEqual([alice.id, "DRAW", [], true]);
    expect(v.you.cards).toEqual(before);
    expect(v.turn.playerId).toBe(bob.id);
  });

  it("post-draw: check automático si no hay apuesta; fold si la hay", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    let v = await view(app, m, alice);
    await act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion });
    v = await view(app, m, bob);
    await act(app, m, bob, { type: "BET", amount: 0, actionVersion: v.stateVersion });
    v = await view(app, m, alice);
    await act(app, m, alice, { type: "DRAW", discardedIndexes: [], actionVersion: v.stateVersion });
    v = await view(app, m, bob);
    await act(app, m, bob, { type: "DRAW", discardedIndexes: [], actionVersion: v.stateVersion });

    v = await timeOut(m, bob); // Alice abre la ronda post-draw y se le vence: check
    let a = await lastAction(m);
    expect([a.playerId, a.type, a.amount, a.isAuto]).toEqual([alice.id, "BET", 0, true]);
    expect(v.phase).toBe("BETTING_POST_DRAW");

    v = await view(app, m, bob);
    await act(app, m, bob, { type: "BET", amount: 40, actionVersion: v.stateVersion });
    v = await timeOut(m, bob); // Alice frente a una apuesta: fold
    a = await lastAction(m);
    expect([a.playerId, a.type, a.isAuto]).toEqual([alice.id, "FOLD", true]);
    expect(v.handNumber).toBe(2);
  });
});
