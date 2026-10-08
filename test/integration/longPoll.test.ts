import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { ensureMatchListener, notifyMatchChanged, subscribeToMatch } from "../../src/infrastructure/matchNotifier.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

async function startMatch(): Promise<{ matchId: string; alice: TestPlayer; bob: TestPlayer }> {
  const alice = await registerPlayer(app, `alice-lp-${Math.random().toString(36).slice(2, 7)}`);
  const bob = await registerPlayer(app, `bob-lp-${Math.random().toString(36).slice(2, 7)}`);
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, turnTimeoutSeconds: 120, inviteeId: bob.id },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/v1/matches/${created.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: created.joinToken },
  });
  return { matchId: created.id, alice, bob };
}

const view = async (matchId: string, player: TestPlayer, query = "") =>
  app.inject({ method: "GET", url: `/v1/matches/${matchId}${query}`, headers: { authorization: `Bearer ${player.token}` } });

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

describe("long-poll de GET /v1/matches/:id?since=N", () => {
  it("sin `since` responde de inmediato, como siempre", async () => {
    const { matchId, alice } = await startMatch();
    const { value, ms } = await timed(() => view(matchId, alice));
    expect(value.statusCode).toBe(200);
    expect(ms).toBeLessThan(1000);
  });

  it("si el cliente está atrasado (since < versión actual) responde de inmediato", async () => {
    const { matchId, alice } = await startMatch();
    const current = (await view(matchId, alice)).json().stateVersion;
    const { value, ms } = await timed(() => view(matchId, alice, `?since=${current - 1}`));
    expect(value.json().stateVersion).toBe(current);
    expect(ms).toBeLessThan(1000);
  });

  it("espera y responde en cuanto el rival juega, con la versión nueva", async () => {
    const { matchId, alice, bob } = await startMatch();
    const before = (await view(matchId, bob)).json();

    const waiting = timed(() => view(matchId, bob, `?since=${before.stateVersion}`));
    await new Promise((r) => setTimeout(r, 300)); // que quede esperando de verdad
    await app.inject({
      method: "POST",
      url: `/v1/matches/${matchId}/actions`,
      headers: authHeaders(alice),
      payload: { type: "BET", amount: 20, actionVersion: before.stateVersion },
    });

    const { value, ms } = await waiting;
    expect(value.json().stateVersion).toBeGreaterThan(before.stateVersion);
    expect(value.json().turn.playerId).toBe(bob.id);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(3000); // no esperó los 25 s
  });

  it("se despierta al vencer el turno y devuelve el estado con el timeout ya resuelto", async () => {
    const { matchId, alice } = await startMatch();
    const before = (await view(matchId, alice)).json();
    await prisma.hand.updateMany({
      where: { matchId, phase: { not: "HAND_FINISHED" } },
      data: { turnExpiresAt: new Date(Date.now() + 400) },
    });

    const { value, ms } = await timed(() => view(matchId, alice, `?since=${before.stateVersion}`));
    expect(ms).toBeLessThan(3000);
    expect(value.json().stateVersion).toBeGreaterThan(before.stateVersion); // auto-fold aplicado
  });

  it("en una partida terminada responde de inmediato aunque no haya versión nueva", async () => {
    const { matchId, alice } = await startMatch();
    await app.inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: authHeaders(alice) });
    const finished = (await view(matchId, alice)).json();
    const { value, ms } = await timed(() => view(matchId, alice, `?since=${finished.stateVersion}`));
    expect(value.json().status).toBe("MATCH_FINISHED");
    expect(ms).toBeLessThan(1000);
  });

  it("cerrar el servidor libera los long-polls abiertos en vez de esperar 25 s", async () => {
    const own = await createTestApp();
    const { matchId, alice } = await startMatch();
    const current = (await view(matchId, alice)).json().stateVersion;
    const waiting = timed(() =>
      own.inject({ method: "GET", url: `/v1/matches/${matchId}?since=${current}`, headers: { authorization: `Bearer ${alice.token}` } }),
    );
    await new Promise((r) => setTimeout(r, 300));
    await own.close();
    const { value, ms } = await waiting;
    expect(value.statusCode).toBe(200);
    expect(ms).toBeLessThan(3000);
  });

  it("rechaza un `since` inválido", async () => {
    const { matchId, alice } = await startMatch();
    expect((await view(matchId, alice, "?since=-1")).statusCode).toBe(400);
    expect((await view(matchId, alice, "?since=abc")).statusCode).toBe(400);
  });
});

describe("LISTEN/NOTIFY", () => {
  it("un NOTIFY emitido desde OTRA conexión a Postgres despierta la espera (camino entre instancias)", async () => {
    await ensureMatchListener();
    const wait = subscribeToMatch("partida-x", 5000);
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL!.replace(/\?.*$/, "") });
    await other.connect();
    await other.query("SELECT pg_notify('match_changed', 'partida-x')");
    await other.end();
    expect(await wait.changed).toBe(true);
  });

  it("una transacción que se revierte no despierta a nadie", async () => {
    await ensureMatchListener();
    const wait = subscribeToMatch("partida-y", 800);
    await expect(
      prisma.$transaction(async (tx) => {
        await notifyMatchChanged(tx, "partida-y");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await wait.changed).toBe(false); // venció el plazo sin aviso
  });

  it("el aviso de una transacción confirmada llega", async () => {
    await ensureMatchListener();
    const wait = subscribeToMatch("partida-z", 5000);
    await prisma.$transaction(async (tx) => notifyMatchChanged(tx, "partida-z"));
    expect(await wait.changed).toBe(true);
  });
});
