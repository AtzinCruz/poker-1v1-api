import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { lockAndLoadMatch, tryLockAndLoadMatch } from "../../src/application/locks.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
});

async function createMatch(alice: TestPlayer, bob: TestPlayer) {
  return (
    await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    })
  ).json();
}

describe("lockAndLoadMatch", () => {
  it("devuelve exactamente lo mismo que findUnique, en espera y en curso (nulls, fechas y enums)", async () => {
    const alice = await registerPlayer(app, "alice-lock");
    const bob = await registerPlayer(app, "bob-lock");
    const created = await createMatch(alice, bob);

    const compare = () =>
      prisma.$transaction(async (tx) => {
        const viaRaw = await lockAndLoadMatch(tx, created.id);
        const viaPrisma = await tx.match.findUnique({ where: { id: created.id } });
        expect(viaRaw).toEqual(viaPrisma);
        expect(viaRaw!.createdAt).toBeInstanceOf(Date);
      });

    await compare(); // WAITING_FOR_OPPONENT: player2Id, stacks y dealer en null
    await app.inject({
      method: "POST",
      url: `/v1/matches/${created.id}/join`,
      headers: authHeaders(bob),
      payload: { joinToken: created.joinToken },
    });
    await compare(); // IN_PROGRESS: todo poblado
  });

  it("devuelve null si la partida no existe", async () => {
    await prisma.$transaction(async (tx) => {
      expect(await lockAndLoadMatch(tx, "no-existe")).toBeNull();
      expect(await tryLockAndLoadMatch(tx, "no-existe")).toBeNull();
    });
  });
});

describe("caché de tokenVersion", () => {
  it("peticiones seguidas del mismo jugador no vuelven a consultar su tokenVersion", async () => {
    const alice = await registerPlayer(app, "alice-cache");
    const spy = vi.spyOn(prisma.player, "findUnique");
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/invitations", headers: authHeaders(alice) });
      expect(res.statusCode).toBe(200);
    }
    const tokenVersionLookups = spy.mock.calls.filter(([args]) => args?.select && "tokenVersion" in args.select);
    expect(tokenVersionLookups.length).toBeLessThanOrEqual(1);
  });

  it("cambiar la contraseña revoca al instante el token cacheado (misma instancia)", async () => {
    const alice = await registerPlayer(app, "alice-revoke");
    const oldHeaders = { authorization: `Bearer ${alice.token}` };
    expect((await app.inject({ method: "GET", url: "/v1/wallet", headers: oldHeaders })).statusCode).toBe(200); // queda en caché

    const changed = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: oldHeaders,
      payload: { currentPassword: "contraseña-de-prueba-123", newPassword: "otra-contraseña-456" },
    });
    expect(changed.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/v1/wallet", headers: oldHeaders })).statusCode).toBe(401);
    const fresh = { authorization: `Bearer ${changed.json().token}` };
    expect((await app.inject({ method: "GET", url: "/v1/wallet", headers: fresh })).statusCode).toBe(200);
  });
});

describe("nombre del rival en la vista", () => {
  it("cada jugador ve el nombre del otro, también cuando la lectura resuelve un turno vencido", async () => {
    const alice = await registerPlayer(app, "alice-name");
    const bob = await registerPlayer(app, "bob-name");
    const created = await createMatch(alice, bob);

    const waiting = (await app.inject({ method: "GET", url: `/v1/matches/${created.id}`, headers: authHeaders(alice) })).json();
    expect(waiting.opponent).toBeNull(); // todavía no se unió

    await app.inject({
      method: "POST",
      url: `/v1/matches/${created.id}/join`,
      headers: authHeaders(bob),
      payload: { joinToken: created.joinToken },
    });
    const forAlice = (await app.inject({ method: "GET", url: `/v1/matches/${created.id}`, headers: authHeaders(alice) })).json();
    const forBob = (await app.inject({ method: "GET", url: `/v1/matches/${created.id}`, headers: authHeaders(bob) })).json();
    expect(forAlice.opponent.displayName).toBe("bob-name");
    expect(forBob.opponent.displayName).toBe("alice-name");

    // Camino lento (turno vencido → lock + resolución): el nombre sigue presente.
    await prisma.hand.updateMany({
      where: { matchId: created.id, phase: { not: "HAND_FINISHED" } },
      data: { turnExpiresAt: new Date(Date.now() - 1000) },
    });
    const afterTimeout = (await app.inject({ method: "GET", url: `/v1/matches/${created.id}`, headers: authHeaders(bob) })).json();
    expect(afterTimeout.handNumber).toBe(2);
    expect(afterTimeout.opponent.displayName).toBe("alice-name");
  });
});
