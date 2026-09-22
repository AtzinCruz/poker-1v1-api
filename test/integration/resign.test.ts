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

  it("entrega el saldo en juego al rival cuando alguien abandona una partida en curso (sección 9)", async () => {
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
    // Alice se queda con su stack restante (990: 1000 - 10 de ciega); Bob se lleva el suyo (980) íntegro.
    expect(aliceWallet.blocked).toBe(0);
    expect(bobWallet.blocked).toBe(0);
    expect(aliceWallet.available).toBe(990);
    expect(bobWallet.available).toBe(980);

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
    expect(aliceWallet.available).toBe(990);
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
});
