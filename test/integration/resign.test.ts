import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

async function getWallet(player: TestPlayer) {
  const res = await app.inject({
    method: "GET",
    url: "/v1/wallet",
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

describe("abandonar partida (resign)", () => {
  it("cancela la partida y devuelve el saldo reservado si nadie se había unido todavía", async () => {
    const alice = await registerPlayer(app, "alice-resign-waiting");
    const bob = await registerPlayer(app, "bob-resign-waiting");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    const match = createRes.json();

    const before = await getWallet(alice);
    expect(before.blocked).toBe(1000);
    expect(before.available).toBe(0);

    const resignRes = await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: authHeaders(alice),
    });
    expect(resignRes.statusCode).toBe(200);
    expect(resignRes.json().status).toBe("CANCELLED");

    const after = await getWallet(alice);
    expect(after.blocked).toBe(0);
    expect(after.available).toBe(1000);
  });

  it("quien abandona una partida en curso se va con su stack; el rival gana la partida y el pozo de la mano", async () => {
    const alice = await registerPlayer(app, "alice-resign-progress");
    const bob = await registerPlayer(app, "bob-resign-progress");

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

    // Alice (botón, ya posteó la ciega chica) abandona.
    const resignRes = await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: authHeaders(alice),
    });
    expect(resignRes.statusCode).toBe(200);
    const body = resignRes.json();
    expect(body.status).toBe("MATCH_FINISHED");

    const aliceWallet = await getWallet(alice);
    const bobWallet = await getWallet(bob);
    // Abandonar = retirarse de la mano en curso y quedarse con el resto: Alice conserva sus 990 y Bob
    // suma el pozo (30) a su stack (980). Entraron 2000 fichas y salen 2000: nada se destruye ni se crea.
    expect(aliceWallet.blocked).toBe(0);
    expect(bobWallet.blocked).toBe(0);
    expect(aliceWallet.available).toBe(990);
    expect(bobWallet.available).toBe(1010);

    const matchView = await app.inject({
      method: "GET",
      url: `/v1/matches/${match.id}`,
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(matchView.json().finishReason).toBe("RESIGN");
    expect(matchView.json().winnerId).toBe(bob.id);
  });

  it("una segunda llamada a resign sobre una partida ya terminada es idempotente por estado (no falla)", async () => {
    const alice = await registerPlayer(app, "alice-resign-twice");
    const bob = await registerPlayer(app, "bob-resign-twice");
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

    await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: authHeaders(alice),
    });

    const second = await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: authHeaders(alice),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("MATCH_FINISHED");

    // El saldo no se liquidó dos veces.
    const aliceWallet = await getWallet(alice);
    const bobWallet = await getWallet(bob);
    expect(aliceWallet.available).toBe(990);
    expect(bobWallet.available).toBe(1010);
  });

  it("un jugador ajeno a la partida no puede abandonarla por ella", async () => {
    const alice = await registerPlayer(app, "alice-resign-stranger");
    const bob = await registerPlayer(app, "bob-resign-stranger");
    const stranger = await registerPlayer(app, "stranger-resign");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    const match = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: authHeaders(stranger),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("NOT_MATCH_PLAYER");
  });

  it("resign sin body pero con Content-Type: application/json (como manda el navegador) no revienta en 500 (regresión)", async () => {
    const alice = await registerPlayer(app, "alice-resign-emptyjson");
    const bob = await registerPlayer(app, "bob-resign-emptyjson");
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    const match = createRes.json();

    // Fastify rechaza un body vacío con Content-Type: application/json (FST_ERR_CTP_EMPTY_JSON_BODY);
    // el manejador de errores debe devolver ese 4xx tal cual, no enmascararlo como 500.
    const res = await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/resign`,
      headers: { ...authHeaders(alice), "content-type": "application/json" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });
});
