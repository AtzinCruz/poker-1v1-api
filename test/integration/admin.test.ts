import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestApp, registerPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { config } from "../../src/config.js";

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

    const key = randomUUID();
    const addRes = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: { ...adminHeaders, "idempotency-key": key },
      payload: { amount: 500 },
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json().fictionalBalance).toBe(500);

    // Un doble clic (misma clave) no acredita dos veces (AUD-20); sin clave se rechaza.
    const again = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: { ...adminHeaders, "idempotency-key": key },
      payload: { amount: 500 },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().fictionalBalance).toBe(500);
    const noKey = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: adminHeaders,
      payload: { amount: 500 },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("rechaza un monto negativo o cero al agregar saldo", async () => {
    const alice = await registerPlayer(app, "alice-admin-badamount");
    const adminSession = (await adminLogin()).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers: { authorization: `Bearer ${adminSession.token}`, "idempotency-key": randomUUID() },
      payload: { amount: -50 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("cuentas de administrador con nombre propio (AUD-20)", () => {
  const account = { name: "ana-admin", secret: "clave-propia-de-ana-123" };

  async function withAccount(fn: () => Promise<void>) {
    config.adminAccounts.push(account);
    try {
      await fn();
    } finally {
      config.adminAccounts.splice(config.adminAccounts.indexOf(account), 1);
    }
  }

  it("el nombre tiene que corresponder a su clave, y queda tal cual en el registro de auditoría", async () => {
    await withAccount(async () => {
      const wrongName = await app.inject({
        method: "POST",
        url: "/v1/auth/admin-session",
        payload: { displayName: "otra-persona", secret: account.secret },
      });
      expect(wrongName.statusCode).toBe(401);

      const ok = await app.inject({ method: "POST", url: "/v1/auth/admin-session", payload: { displayName: account.name, secret: account.secret } });
      expect(ok.statusCode).toBe(201);
      const alice = await registerPlayer(app, "alice-admin-acct");
      const credit = await app.inject({
        method: "POST",
        url: `/v1/admin/players/${alice.id}/add-balance`,
        headers: { authorization: `Bearer ${ok.json().token}`, "idempotency-key": randomUUID() },
        payload: { amount: 10 },
      });
      expect(credit.statusCode).toBe(200);
      const record = await prisma.adminAction.findFirstOrThrow({ where: { playerId: alice.id } });
      expect(record.adminName).toBe(account.name);
    });
  });

  it("quitar la cuenta revoca sus tokens sin tocar los de los demás", async () => {
    let token = "";
    await withAccount(async () => {
      token = (await app.inject({ method: "POST", url: "/v1/auth/admin-session", payload: { displayName: account.name, secret: account.secret } })).json().token;
      expect((await app.inject({ method: "GET", url: "/v1/admin/players", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    });
    expect((await app.inject({ method: "GET", url: "/v1/admin/players", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const shared = (await adminLogin()).json().token;
    expect((await app.inject({ method: "GET", url: "/v1/admin/players", headers: { authorization: `Bearer ${shared}` } })).statusCode).toBe(200);
  });
});
