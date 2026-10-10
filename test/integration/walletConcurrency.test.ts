/**
 * AUD-01 (regresión): la liquidación leía al jugador sin lock y escribía un saldo absoluto, así que una
 * reserva, otra liquidación o un abono de admin concurrentes se perdían (fichas creadas y destruidas).
 * Ahora todo cambio de saldo es un incremento atómico y la liquidación bloquea a los jugadores por id.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import {
  blockedMismatches,
  cmd,
  createMatch,
  makePlayer,
  rawClient,
  resign,
  startMatch,
  totalChips,
  waitForLockWaiters,
  walletOf,
} from "../helpers/scenario.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe("liquidación de cartera concurrente (AUD-01)", () => {
  it("intercalado exacto: crear otra partida mientras se liquida la anterior no borra la reserva nueva", async () => {
    const alice = await makePlayer("alice", 2000);
    const bob = await makePlayer("bob", 1000);
    const m1 = await startMatch(app, alice, bob); // alice 1000/1000, bob 0/1000; Alice es botón (ciega chica)
    const chipsBefore = await totalChips(); // 3000

    // Una conexión aparte retiene el lock de la fila de Alice solo para fijar el orden de llegada.
    const locker = await rawClient();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM "Player" WHERE id = $1 FOR UPDATE`, [alice.id]);

      const createP = createMatch(app, alice, bob); // reserva de M2 sobre Alice: espera
      await waitForLockWaiters(locker, 1);
      const resignP = resign(app, m1, bob); // liquidación de M1 sobre Alice: espera detrás
      await waitForLockWaiters(locker, 2);

      await locker.query("COMMIT");
      const [created, resigned] = await Promise.all([createP, resignP]);
      expect(created.statusCode).toBe(201);
      expect(resigned.statusCode).toBe(200);

      // 2000 − 1000 (M1) − 1000 (M2) + 1020 (su stack de M1, 990, más el pozo de 30) = 1020; bloqueadas 1000 (M2).
      expect(await blockedMismatches()).toEqual([]);
      expect(await walletOf(alice)).toEqual({ available: 1020, blocked: 1000 });

      const m2 = created.json().id as string;
      expect((await resign(app, m2, alice)).statusCode).toBe(200);
      expect(await totalChips()).toBe(chipsBefore);
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
    }
  });

  it("carga realista: N rivales abandonan a la vez sus partidas contra el mismo jugador", async () => {
    const N = 8;
    const hub = await makePlayer("hub", N * 1000);
    const rivals = await Promise.all(Array.from({ length: N }, (_, i) => makePlayer(`rival${i}`, 1000)));
    const matches: string[] = [];
    for (const r of rivals) matches.push(await startMatch(app, hub, r));
    const chipsBefore = await totalChips();
    expect(await walletOf(hub)).toEqual({ available: 0, blocked: N * 1000 });

    const results = await Promise.all(matches.map((m, i) => resign(app, m, rivals[i]!)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));

    // En cada partida el hub conserva 990 y gana el pozo de 30; cada rival se va con sus 980.
    expect(await walletOf(hub)).toEqual({ available: N * 1020, blocked: 0 });
    for (const r of rivals) expect(await walletOf(r)).toEqual({ available: 980, blocked: 0 });
    expect(await blockedMismatches()).toEqual([]);
    expect(await totalChips()).toBe(chipsBefore);
  });

  it("un abono de admin concurrente con una liquidación no se pierde", async () => {
    const alice = await makePlayer("alice", 1000);
    const bob = await makePlayer("bob", 1000);
    const m1 = await startMatch(app, alice, bob);

    const adminLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/admin-session",
      payload: { displayName: "auditor", secret: process.env.ADMIN_SECRET },
    });
    const adminToken = adminLogin.json().token as string;

    const locker = await rawClient();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM "Player" WHERE id = $1 FOR UPDATE`, [alice.id]);
      const addP = app.inject({
        method: "POST",
        url: `/v1/admin/players/${alice.id}/add-balance`,
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
        payload: { amount: 500 },
      });
      await waitForLockWaiters(locker, 1);
      const resignP = app.inject({ method: "POST", url: `/v1/matches/${m1}/resign`, headers: cmd(bob) });
      await waitForLockWaiters(locker, 2);
      await locker.query("COMMIT");
      const [added, resigned] = await Promise.all([addP, resignP]);
      expect(added.statusCode).toBe(200);
      expect(resigned.statusCode).toBe(200);

      // 0 disponible tras reservar + 500 del abono + 1020 de la partida ganada.
      expect(await walletOf(alice)).toEqual({ available: 1520, blocked: 0 });
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
    }
  });

  it("la BD rechaza un saldo negativo en vez de esconder el desajuste (AUD-18)", async () => {
    const alice = await makePlayer("alice", 100);
    await expect(
      prisma.player.update({ where: { id: alice.id }, data: { blockedBalance: { decrement: 1 } } }),
    ).rejects.toThrow(/Player_blockedBalance_nonnegative/);
    await expect(
      prisma.player.update({ where: { id: alice.id }, data: { fictionalBalance: { decrement: 101 } } }),
    ).rejects.toThrow(/Player_fictionalBalance_nonnegative/);
  });
});
