import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { purgeIdempotencyRecords, sweepExpiredTurns } from "../../src/application/maintenance.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

async function startMatch(alice: TestPlayer, bob: TestPlayer): Promise<string> {
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/v1/matches/${created.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: created.joinToken },
  });
  return created.id;
}

async function expireTurn(matchId: string, secondsAgo: number): Promise<void> {
  await prisma.hand.updateMany({
    where: { matchId, phase: { not: "HAND_FINISHED" } },
    data: { turnExpiresAt: new Date(Date.now() - secondsAgo * 1000) },
  });
}

const handNumber = async (matchId: string) =>
  (await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).handNumber;

describe("barrido de turnos vencidos", () => {
  it("salta una partida bloqueada en vez de esperarla, y la resuelve en la pasada siguiente", async () => {
    const matchId = await startMatch(await registerPlayer(app, "alice-skip"), await registerPlayer(app, "bob-skip"));
    await expireTurn(matchId, 5);

    let release!: () => void;
    let locked!: () => void;
    const lockAcquired = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
        locked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await lockAcquired;

    const started = Date.now();
    expect(await sweepExpiredTurns()).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000); // con FOR UPDATE a secas se quedaba esperando al holder
    expect(await handNumber(matchId)).toBe(1);

    release();
    await holder;
    expect(await sweepExpiredTurns()).toBe(1);
    expect(await handNumber(matchId)).toBe(2);
  });

  it("procesa primero los turnos más atrasados cuando hay más vencidos que el lote", async () => {
    const [a1, b1, a2, b2] = await Promise.all(["a1", "b1", "a2", "b2"].map((n) => registerPlayer(app, `${n}-order`)));
    const recent = await startMatch(a1!, b1!);
    const oldest = await startMatch(a2!, b2!);
    await expireTurn(recent, 5);
    await expireTurn(oldest, 300);

    expect(await sweepExpiredTurns(new Date(), () => {}, 1)).toBe(1);
    expect(await handNumber(oldest)).toBe(2);
    expect(await handNumber(recent)).toBe(1);
  });
});

describe("purga de idempotencia", () => {
  it("borra en lotes los registros más viejos que el TTL y conserva los recientes", async () => {
    const alice = await registerPlayer(app, "alice-purge");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const rows = (n: number, createdAt: Date, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({
        playerId: alice.id,
        key: `${prefix}-${i}`,
        requestHash: "h",
        responseStatus: 200,
        responseBody: {},
        createdAt,
      }));
    // 5003 viejos: obliga a más de un lote de 5000.
    await prisma.idempotencyRecord.createMany({ data: rows(5003, old, "old") });
    await prisma.idempotencyRecord.createMany({ data: rows(3, new Date(), "new") });

    expect(await purgeIdempotencyRecords()).toBe(5003);
    const remaining = await prisma.idempotencyRecord.findMany({ where: { playerId: alice.id } });
    expect(remaining.map((r) => r.key).sort()).toEqual(["new-0", "new-1", "new-2"]);
  });
});
