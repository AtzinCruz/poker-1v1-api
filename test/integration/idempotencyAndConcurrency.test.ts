import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

async function setupMatch(alice: TestPlayer, bob: TestPlayer) {
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/matches",
    headers: authHeaders(alice),
    payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
  });
  const match = createRes.json();
  await app.inject({
    method: "POST",
    url: `/v1/matches/${match.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: match.joinToken },
  });
  return match.id as string;
}

async function getView(matchId: string, player: TestPlayer) {
  const res = await app.inject({
    method: "GET",
    url: `/v1/matches/${matchId}`,
    headers: { authorization: `Bearer ${player.token}` },
  });
  return res.json();
}

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe("idempotencia y control de concurrencia", () => {
  it("un POST repetido con la misma Idempotency-Key devuelve el resultado original sin duplicar fichas (criterio 13)", async () => {
    const alice = await registerPlayer(app, "alice-idem");
    const bob = await registerPlayer(app, "bob-idem");
    const matchId = await setupMatch(alice, bob);

    const view = await getView(matchId, alice);
    const key = randomUUID();
    const payload = { type: "BET", amount: 20, actionVersion: view.stateVersion };

    const first = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice, key),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().idempotentReplay).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice, key),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotentReplay).toBe(true);
    expect(second.json().actionId).toBe(first.json().actionId);

    // El turno solo avanzó una vez: le toca a Bob, no volvió a ser el turno de Alice.
    const afterView = await getView(matchId, bob);
    expect(afterView.turn.playerId).toBe(bob.id);
  });

  it("la misma Idempotency-Key con un body distinto devuelve 409 IDEMPOTENCY_CONFLICT", async () => {
    const alice = await registerPlayer(app, "alice-conflict");
    const bob = await registerPlayer(app, "bob-conflict");
    const matchId = await setupMatch(alice, bob);
    const view = await getView(matchId, alice);
    const key = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice, key),
      payload: { type: "BET", amount: 20, actionVersion: view.stateVersion },
    });
    expect(first.statusCode).toBe(200);

    const conflicting = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice, key),
      payload: { type: "FOLD", actionVersion: view.stateVersion },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("una acción con actionVersion desactualizado recibe 409 STALE_STATE y no altera el estado (criterio 14)", async () => {
    const alice = await registerPlayer(app, "alice-stale");
    const bob = await registerPlayer(app, "bob-stale");
    const matchId = await setupMatch(alice, bob);
    const view = await getView(matchId, alice);

    const res = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice),
      payload: { type: "BET", amount: 20, actionVersion: view.stateVersion - 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("STALE_STATE");
    expect(res.json().currentState).toBeTruthy();

    const stillWaiting = await getView(matchId, alice);
    expect(stillWaiting.turn.playerId).toBe(alice.id);
    expect(stillWaiting.phase).toBe("BETTING_PRE_DRAW");
  });

  it("rechaza acciones fuera de turno y fuera de fase (criterio 10)", async () => {
    const alice = await registerPlayer(app, "alice-turn");
    const bob = await registerPlayer(app, "bob-turn");
    const matchId = await setupMatch(alice, bob);
    const view = await getView(matchId, alice);

    // Bob intenta actuar cuando le toca a Alice.
    const outOfTurn = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(bob),
      payload: { type: "BET", amount: 20, actionVersion: view.stateVersion },
    });
    expect(outOfTurn.statusCode).toBe(400);
    expect(outOfTurn.json().code).toBe("INVALID_ACTION");

    // Alice intenta hacer DRAW durante una ronda de apuestas.
    const wrongPhase = await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice),
      payload: { type: "DRAW", discardedIndexes: [], actionVersion: view.stateVersion },
    });
    expect(wrongPhase.statusCode).toBe(400);
    expect(wrongPhase.json().code).toBe("INVALID_ACTION");
  });
});
