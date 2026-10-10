/**
 * Carreras (regresión de la auditoría): doble envío, acciones distintas en paralelo, acción + timeout +
 * lecturas + barrido, uniones y revanchas simultáneas, misma Idempotency-Key en dos partidas a la vez
 * (AUD-05) y órdenes de lock cruzados (AUD-04).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { sweepExpiredTurns } from "../../src/application/maintenance.js";
import {
  act,
  bearer,
  blockedMismatches,
  cmd,
  createMatch,
  expireCurrentTurn,
  makePlayer,
  rawClient,
  resign,
  startMatch,
  totalChips,
  view,
  waitForLockWaiters,
} from "../helpers/scenario.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

const actionsOf = (matchId: string) => prisma.action.count({ where: { matchId } });

describe("doble envío y acciones en paralelo", () => {
  it("5 envíos simultáneos con la MISMA clave: una sola ejecución, el resto son repeticiones", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const v = await view(app, m, alice);
    const key = randomUUID();
    const body = { type: "BET", amount: 20, actionVersion: v.stateVersion };
    const res = await Promise.all(Array.from({ length: 5 }, () => act(app, m, alice, body, key)));
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(res.map((r) => r.json().actionId)).size).toBe(1);
    expect(res.filter((r) => !r.json().idempotentReplay)).toHaveLength(1);
    expect(await actionsOf(m)).toBe(1);
  });

  it("5 envíos simultáneos con claves distintas: uno gana, los demás 409 STALE_STATE", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const v = await view(app, m, alice);
    const res = await Promise.all(
      Array.from({ length: 5 }, () => act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion })),
    );
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await actionsOf(m)).toBe(1);
  });

  it("BET y FOLD a la vez del mismo jugador: solo una se aplica", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const v = await view(app, m, alice);
    const res = await Promise.all([
      act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion }),
      act(app, m, alice, { type: "FOLD", actionVersion: v.stateVersion }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await actionsOf(m)).toBe(1);
    expect(await totalChips()).toBe(2000);
  });

  it("acción + dos lecturas + barrido sobre un turno vencido (20 rondas): un solo efecto por turno", async () => {
    const alice = await makePlayer("alice", 100_000);
    const bob = await makePlayer("bob", 100_000);
    const chips = await totalChips();
    for (let round = 0; round < 20; round++) {
      const m = await startMatch(app, alice, bob);
      const v = await view(app, m, alice); // turno de Alice (botón) en BETTING_PRE_DRAW
      await expireCurrentTurn(m);
      const [r] = await Promise.all([
        act(app, m, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion }),
        app.inject({ method: "GET", url: `/v1/matches/${m}`, headers: bearer(bob) }),
        app.inject({ method: "GET", url: `/v1/matches/${m}`, headers: bearer(alice) }),
        sweepExpiredTurns(),
      ]);
      // O bien Alice llegó antes que el timeout (200) o el timeout ya la retiró (409): nunca ambas cosas.
      const hand1 = await prisma.action.findMany({ where: { matchId: m, hand: { number: 1 } }, orderBy: { createdAt: "asc" } });
      const first = hand1[0]!;
      expect(hand1.filter((a) => a.playerId === alice.id)).toHaveLength(1);
      expect(r!.statusCode === 200 ? !first.isAuto : first.isAuto && first.type === "FOLD").toBe(true);
      expect(await blockedMismatches()).toEqual([]);
      await resign(app, m, bob);
    }
    expect(await totalChips()).toBe(chips);
  });
});

describe("uniones y revanchas simultáneas", () => {
  it("el invitado se une dos veces a la vez: una entra, la otra 400, y la reserva se cobra una sola vez", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob", 5000);
    const created = (await createMatch(app, alice, bob)).json();
    const join = () =>
      app.inject({ method: "POST", url: `/v1/matches/${created.id}/join`, headers: cmd(bob), payload: { joinToken: created.joinToken } });
    const res = await Promise.all([join(), join(), join()]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
    expect(await blockedMismatches()).toEqual([]);
    const b = await prisma.player.findUniqueOrThrow({ where: { id: bob.id } });
    expect([b.fictionalBalance, b.blockedBalance]).toEqual([4000, 1000]);
  });

  it("un tercero con el joinToken no puede sentarse aunque lo intente a la vez que el invitado", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const eve = await makePlayer("eve");
    const created = (await createMatch(app, alice, bob)).json();
    const [eveRes, bobRes] = await Promise.all(
      [eve, bob].map((p) =>
        app.inject({ method: "POST", url: `/v1/matches/${created.id}/join`, headers: cmd(p), payload: { joinToken: created.joinToken } }),
      ),
    );
    // Siempre 403: la invitación se comprueba antes que el estado, así que un no invitado no puede
    // distinguir una partida ajena en espera de una ya empezada (AUD-15).
    expect(eveRes!.statusCode).toBe(403);
    expect(bobRes!.statusCode).toBe(200);
    const m = await prisma.match.findUniqueOrThrow({ where: { id: created.id } });
    expect(m.player2Id).toBe(bob.id);
  });

  it("la misma persona pide la revancha dos veces a la vez: una sola partida nueva y una sola reserva", async () => {
    const alice = await makePlayer("alice", 5000);
    const bob = await makePlayer("bob", 5000);
    const m = await startMatch(app, alice, bob);
    await resign(app, m, bob);
    const res = await Promise.all([0, 1, 2].map(() => app.inject({ method: "POST", url: `/v1/matches/${m}/rematch`, headers: cmd(alice) })));
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    expect(await prisma.match.count({ where: { status: "WAITING_FOR_OPPONENT" } })).toBe(1);
    expect(await blockedMismatches()).toEqual([]);
  });
});

describe("AUD-05 Idempotency-Key reutilizada a la vez en dos partidas", () => {
  it("la segunda recibe 409 IDEMPOTENCY_CONFLICT, no un 500", async () => {
    const alice = await makePlayer("alice", 5000);
    const bob = await makePlayer("bob", 5000);
    const m1 = await startMatch(app, alice, bob);
    const m2 = await startMatch(app, alice, bob);
    const [v1, v2] = await Promise.all([view(app, m1, alice), view(app, m2, alice)]);
    const key = randomUUID();
    const res = await Promise.all([
      act(app, m1, alice, { type: "BET", amount: 20, actionVersion: v1.stateVersion }, key),
      act(app, m2, alice, { type: "BET", amount: 20, actionVersion: v2.stateVersion }, key),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});

describe("AUD-04 órdenes de lock cruzados: sin deadlock ni 500", () => {
  it("dos partidas entre los mismos jugadores con asientos invertidos terminan a la vez", async () => {
    const alice = await makePlayer("alice", 5000);
    const bob = await makePlayer("bob", 5000);
    const m1 = await startMatch(app, alice, bob); // player1 = Alice
    const m2 = await startMatch(app, bob, alice); // player1 = Bob (p. ej. una revancha pedida por Bob)

    const locker = await rawClient();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM "Player" WHERE id = $1 FOR UPDATE`, [alice.id]);
      // T1: Bob abandona M1 → liquida player1 (Alice: espera al locker) y luego player2 (Bob).
      const r1 = resign(app, m1, bob);
      await waitForLockWaiters(locker, 1);
      // T2: Alice abandona M2 → liquida player1 (Bob: lo toma) y luego player2 (Alice: espera).
      const r2 = resign(app, m2, alice);
      await waitForLockWaiters(locker, 2);
      // Antes T1 tomaba a Alice y pedía a Bob mientras T2 tenía a Bob y pedía a Alice. Ahora ambas
      // bloquean a los dos jugadores por id y de una vez: una espera a la otra.
      await locker.query("COMMIT");
      const res = await Promise.all([r1, r2]);
      expect(res.map((r) => `${r.statusCode} ${r.statusCode === 200 ? "" : r.json().message}`)).toEqual(["200 ", "200 "]);
      expect(await blockedMismatches()).toEqual([]);
      expect(await totalChips()).toBe(10_000);
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
    }
  });

  it("cancelar la revancha mientras el rival la acepta: ambos caminos bloquean la original primero", async () => {
    const alice = await makePlayer("alice", 5000);
    const bob = await makePlayer("bob", 5000);
    const original = await startMatch(app, alice, bob);
    await resign(app, original, bob);
    const rematch = (await app.inject({ method: "POST", url: `/v1/matches/${original}/rematch`, headers: cmd(alice) })).json();
    expect(rematch.status).toBe("WAITING_FOR_OPPONENT");

    // Antes: cancelar bloqueaba Revancha → Original y aceptar Original → Revancha (deadlock). Con la
    // original retenida aparte, las dos peticiones quedan esperándola; al soltarla, una espera a la otra.
    const locker = await rawClient();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM "Match" WHERE id = $1 FOR UPDATE`, [original]);
      const cancel = resign(app, rematch.id, alice);
      await waitForLockWaiters(locker, 1);
      const accept = app.inject({ method: "POST", url: `/v1/matches/${original}/rematch`, headers: cmd(bob) });
      await waitForLockWaiters(locker, 2);
      await locker.query("COMMIT");
      const [cancelled, accepted] = await Promise.all([cancel, accept]);
      expect(cancelled.statusCode).toBe(200);
      const final = await prisma.match.findUniqueOrThrow({ where: { id: rematch.id } });
      if (accepted.statusCode === 201) {
        // Ganó la cancelación: Bob ya no tenía revancha que aceptar y pidió una nueva.
        expect(final.status).toBe("CANCELLED");
        expect(accepted.json().id).not.toBe(rematch.id);
      } else {
        // Ganó la aceptación: la revancha empezó y el "cancelar" de Alice fue un abandono.
        expect(accepted.statusCode).toBe(200);
        expect(final.status).toBe("MATCH_FINISHED");
      }
      expect(await blockedMismatches()).toEqual([]);
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
    }
  });
});
