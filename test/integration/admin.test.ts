import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

async function adminLogin(secret = process.env.ADMIN_SECRET) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/admin-session",
    payload: { displayName: "admin", secret },
  });
  return res;
}

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe("panel de administración", () => {
  it("rechaza el login de admin con una clave incorrecta", async () => {
    const res = await adminLogin("clave-equivocada");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("acepta el login de admin con la clave correcta y devuelve un token distinto al de jugador", async () => {
    const res = await adminLogin();
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBeTruthy();
    expect(res.json().name).toBe("admin");
  });

  it("un token de jugador normal no sirve para las rutas de admin", async () => {
    const player = await registerPlayer(app, "not-an-admin");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/players",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("lista jugadores y partidas, y permite agregar saldo a un jugador específico", async () => {
    const alice = await registerPlayer(app, "alice-admin-target");
    const bob = await registerPlayer(app, "bob-admin-target");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: { authorization: `Bearer ${alice.token}`, "idempotency-key": crypto.randomUUID() },
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    const match = createRes.json();
    await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/join`,
      headers: { authorization: `Bearer ${bob.token}`, "idempotency-key": crypto.randomUUID() },
      payload: { joinToken: match.joinToken },
    });

    const adminSession = (await adminLogin()).json();
    const adminHeaders = { authorization: `Bearer ${adminSession.token}` };

    const playersRes = await app.inject({ method: "GET", url: "/v1/admin/players", headers: adminHeaders });
    expect(playersRes.statusCode).toBe(200);
    const players = playersRes.json();
    const aliceRow = players.find((p: { id: string }) => p.id === alice.id);
    expect(aliceRow).toBeTruthy();
    expect(aliceRow.fictionalBalance).toBe(0); // reservó 1000 al crear la partida
    expect(aliceRow.blockedBalance).toBe(1000);

    const matchesRes = await app.inject({ method: "GET", url: "/v1/admin/matches", headers: adminHeaders });
    expect(matchesRes.statusCode).toBe(200);
    const matches = matchesRes.json();
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].player1DisplayName).toBe("alice-admin-target");
    expect(matches[0].player2DisplayName).toBe("bob-admin-target");

    const addRes = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: adminHeaders,
      payload: { amount: 500 },
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json().fictionalBalance).toBe(500);
  });

  it("rechaza un monto negativo o cero al agregar saldo", async () => {
    const alice = await registerPlayer(app, "alice-admin-badamount");
    const adminSession = (await adminLogin()).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: { authorization: `Bearer ${adminSession.token}` },
      payload: { amount: -50 },
    });
    expect(res.statusCode).toBe(400);
  });
});
