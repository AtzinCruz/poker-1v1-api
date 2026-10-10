/**
 * Opción al crear la partida: ciegas incrementales (cada 3 manos ambas suben el 5 % del stack inicial)
 * y stack inicial predeterminado de 300.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { act, cmd, makePlayer, view, type AuditPlayer } from "../helpers/scenario.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function create(creator: AuditPlayer, invitee: AuditPlayer, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/matches", headers: cmd(creator), payload: { ...body, inviteeId: invitee.id } });
}

async function join(matchId: string, joinToken: string, p: AuditPlayer) {
  const res = await app.inject({ method: "POST", url: `/v1/matches/${matchId}/join`, headers: cmd(p), payload: { joinToken } });
  expect(res.statusCode).toBe(200);
}

/** Quien tiene el turno se retira: la mano termina y se reparte la siguiente. */
async function foldCurrentHand(matchId: string, a: AuditPlayer, b: AuditPlayer) {
  const v = await view(app, matchId, a);
  const actor = v.turn.playerId === a.id ? a : b;
  const res = await act(app, matchId, actor, { type: "FOLD", actionVersion: v.stateVersion });
  expect(res.statusCode).toBe(200);
}

describe("crear partida: stack inicial y ciegas incrementales", () => {
  it("sin indicar nada, cada jugador entra con 300 fichas y ciegas fijas 10/20", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const res = await create(alice, bob, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().rules).toMatchObject({ startingStack: 300, smallBlind: 10, bigBlind: 20, blindIncrement: 0 });
    expect((await prisma.player.findUniqueOrThrow({ where: { id: alice.id } })).blockedBalance).toBe(300);
  });

  it("cada 3 manos las dos ciegas suben el 5 % del stack inicial (300 → +15)", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const created = await create(alice, bob, { incrementalBlinds: true });
    expect(created.json().rules).toMatchObject({ startingStack: 300, blindIncrement: 15, blindLevelHands: 3 });
    const { id, joinToken } = created.json();
    await join(id, joinToken, bob);

    const blindsByHand: Record<number, unknown> = {};
    for (let hand = 1; hand <= 7; hand++) {
      const v = await view(app, id, alice);
      expect(v.handNumber).toBe(hand);
      blindsByHand[hand] = { ...v.blinds, pot: v.pot };
      if (hand < 7) await foldCurrentHand(id, alice, bob);
    }
    expect(blindsByHand[1]).toEqual({ small: 10, big: 20, level: 0, nextIncreaseAtHand: 4, pot: 30 });
    expect(blindsByHand[3]).toEqual({ small: 10, big: 20, level: 0, nextIncreaseAtHand: 4, pot: 30 });
    expect(blindsByHand[4]).toEqual({ small: 25, big: 35, level: 1, nextIncreaseAtHand: 7, pot: 60 });
    expect(blindsByHand[7]).toEqual({ small: 40, big: 50, level: 2, nextIncreaseAtHand: 10, pot: 90 });

    // La ronda post-draw abre con la ciega grande de la mano en curso como apuesta mínima.
    const hand7 = await prisma.hand.findUniqueOrThrow({ where: { matchId_number: { matchId: id, number: 7 } } });
    expect(hand7.currentBet).toBe(50);
  });

  it("la partida termina cuando las ciegas superan lo que le queda a alguien", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    // 100 fichas → +5 cada 3 manos; las ciegas arrancan altas para llegar pronto.
    const created = await create(alice, bob, { startingStack: 100, smallBlind: 30, bigBlind: 45, incrementalBlinds: true });
    const { id, joinToken } = created.json();
    await join(id, joinToken, bob);
    for (let i = 0; i < 20; i++) {
      const v = await view(app, id, alice);
      if (v.status !== "IN_PROGRESS") break;
      await foldCurrentHand(id, alice, bob);
    }
    const final = await view(app, id, alice);
    expect(final.status).toBe("MATCH_FINISHED");
    expect(final.finishReason).toBe("INSUFFICIENT_STACK");
    const players = await prisma.player.findMany({ where: { id: { in: [alice.id, bob.id] } } });
    expect(players.reduce((sum, p) => sum + p.fictionalBalance + p.blockedBalance, 0)).toBe(2000);
  });

  it("la revancha copia también las ciegas incrementales", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const created = await create(alice, bob, { incrementalBlinds: true });
    const { id, joinToken } = created.json();
    await join(id, joinToken, bob);
    await app.inject({ method: "POST", url: `/v1/matches/${id}/resign`, headers: cmd(bob) });
    const rematch = await app.inject({ method: "POST", url: `/v1/matches/${id}/rematch`, headers: cmd(alice) });
    expect(rematch.json().rules).toMatchObject({ startingStack: 300, blindIncrement: 15, blindLevelHands: 3 });
  });
});
