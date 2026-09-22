import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

async function createAndJoinMatch(
  alice: TestPlayer,
  bob: TestPlayer,
  overrides: Partial<{ startingStack: number; smallBlind: number; bigBlind: number }> = {},
) {
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/matches",
    headers: authHeaders(alice),
    payload: {
      startingStack: overrides.startingStack ?? 1000,
      smallBlind: overrides.smallBlind ?? 10,
      bigBlind: overrides.bigBlind ?? 20,
      inviteeId: bob.id,
    },
  });
  expect(createRes.statusCode).toBe(201);
  const match = createRes.json();

  const joinRes = await app.inject({
    method: "POST",
    url: `/v1/matches/${match.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: match.joinToken },
  });
  expect(joinRes.statusCode).toBe(200);

  return match.id as string;
}

async function getView(matchId: string, player: TestPlayer) {
  const res = await app.inject({
    method: "GET",
    url: `/v1/matches/${matchId}`,
    headers: { authorization: `Bearer ${player.token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function act(
  matchId: string,
  player: TestPlayer,
  body: Record<string, unknown>,
  idempotencyKey = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/v1/matches/${matchId}/actions`,
    headers: authHeaders(player, idempotencyKey),
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

describe("flujo completo de partida", () => {
  it("permite consultar la partida mientras espera al rival, sin cartas ni oponente (regresión)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice-waiting");
    const bob = await registerPlayer(app, "bob-waiting");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    expect(createRes.statusCode).toBe(201);
    const match = createRes.json();

    const view = await getView(match.id, alice);
    expect(view.status).toBe("WAITING_FOR_OPPONENT");
    expect(view.opponent).toBeNull();
    expect(view.you.cards).toEqual([]);
    expect(view.phase).toBeNull();
    expect(view.turn).toBeNull();
  });

  it("crea, une y reparte la primera mano con ciegas y cartas privadas (criterios 1-2)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice");
    const bob = await registerPlayer(app, "bob");
    const matchId = await createAndJoinMatch(alice, bob);

    const aliceView = await getView(matchId, alice);
    const bobView = await getView(matchId, bob);

    expect(aliceView.status).toBe("IN_PROGRESS");
    expect(aliceView.handNumber).toBe(1);
    expect(aliceView.you.cards).toHaveLength(5);
    expect(aliceView.opponent.cardCount).toBe(5);
    expect(aliceView.opponent.cards).toBeUndefined();
    expect(bobView.you.cards).toHaveLength(5);
    // Ciegas 10/20 ya descontadas del pozo
    expect(aliceView.pot).toBe(30);
  });

  it("juega una mano completa: pre-draw, draw, post-draw y showdown (criterios 3-5, 9)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice2");
    const bob = await registerPlayer(app, "bob2");
    const matchId = await createAndJoinMatch(alice, bob);

    let view = await getView(matchId, alice);
    expect(view.phase).toBe("BETTING_PRE_DRAW");
    expect(view.turn.playerId).toBe(alice.id); // el botón actúa primero

    // Alice (botón/ciega chica) iguala la ciega grande.
    let res = await act(matchId, alice, { type: "BET", amount: 20, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    expect(view.legalActions.map((a: { type: string }) => a.type)).toContain("CHECK");

    // Bob cierra la ronda con check.
    res = await act(matchId, bob, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, alice);
    expect(view.phase).toBe("DRAW");
    expect(view.turn.playerId).toBe(alice.id);

    res = await act(matchId, alice, { type: "DRAW", discardedIndexes: [0, 1], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    res = await act(matchId, bob, { type: "DRAW", discardedIndexes: [], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, alice);
    expect(view.phase).toBe("BETTING_POST_DRAW");
    expect(view.turn.playerId).toBe(alice.id);

    res = await act(matchId, alice, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    res = await act(matchId, bob, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    // El showdown liquidó la mano y automáticamente repartió la siguiente (handNumber avanzó).
    view = await getView(matchId, alice);
    expect(view.handNumber).toBe(2);
    expect(["IN_PROGRESS", "MATCH_FINISHED"]).toContain(view.status);

    const summariesRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(summariesRes.statusCode).toBe(200);
    const summaries = summariesRes.json();
    expect(summaries).toHaveLength(1);
    expect(["SHOWDOWN", "SPLIT"]).toContain(summaries[0].winReason);

    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands/1`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const audit = auditRes.json();
    expect(audit.deckSeed).not.toBeNull();
    expect(audit.actions.length).toBeGreaterThan(0);
    // player1Id/player2Id permiten al cliente saber qué mano revelada es la suya en el showdown.
    expect([audit.player1Id, audit.player2Id].sort()).toEqual([alice.id, bob.id].sort());
    expect(audit.revealedCards).toHaveProperty("player1");
    expect(audit.revealedCards).toHaveProperty("player2");
  });

  it("un fold entrega el pozo al rival sin showdown (caso de terminación)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice3");
    const bob = await registerPlayer(app, "bob3");
    const matchId = await createAndJoinMatch(alice, bob);

    const view = await getView(matchId, alice);
    const res = await act(matchId, alice, { type: "FOLD", actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    const summariesRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands`,
      headers: { authorization: `Bearer ${bob.token}` },
    });
    const summaries = summariesRes.json();
    expect(summaries[0].winReason).toBe("FOLD");
    expect(summaries[0].winnerId).toBe(bob.id);

    const bobView = await getView(matchId, bob);
    expect(bobView.you.stack).toBeGreaterThan(1000 - 20); // ganó el pozo
  });
});
