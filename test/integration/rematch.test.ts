import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

// Reglas poco comunes a propósito: la revancha debe copiarlas TODAS, no caer en valores por defecto.
const RULES = { startingStack: 150, smallBlind: 5, bigBlind: 30, turnTimeoutSeconds: 45 };

async function finishedMatch(): Promise<{ matchId: string; alice: TestPlayer; bob: TestPlayer }> {
  const alice = await registerPlayer(app, `alice-${Math.random().toString(36).slice(2, 7)}`);
  const bob = await registerPlayer(app, `bob-${Math.random().toString(36).slice(2, 7)}`);
  const created = (
    await app.inject({ method: "POST", url: "/v1/matches", headers: authHeaders(alice), payload: { ...RULES, inviteeId: bob.id } })
  ).json();
  await app.inject({ method: "POST", url: `/v1/matches/${created.id}/join`, headers: authHeaders(bob), payload: { joinToken: created.joinToken } });
  await app.inject({ method: "POST", url: `/v1/matches/${created.id}/resign`, headers: authHeaders(alice) });
  // Alice pierde 150 de sus 1000; Bob gana 150: ambos pueden pagar otra entrada de 150.
  return { matchId: created.id, alice, bob };
}

const rematch = (matchId: string, player: TestPlayer) =>
  app.inject({ method: "POST", url: `/v1/matches/${matchId}/rematch`, headers: authHeaders(player) });
const view = async (matchId: string, player: TestPlayer) =>
  (await app.inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: { authorization: `Bearer ${player.token}` } })).json();
const wallet = async (player: TestPlayer) =>
  (await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${player.token}` } })).json();

describe("revancha", () => {
  it("el primero que la pide crea una partida con exactamente las mismas reglas, invitando al rival", async () => {
    const { matchId, alice, bob } = await finishedMatch();
    const original = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });

    const res = await rematch(matchId, bob);
    expect(res.statusCode).toBe(201);
    const created = await prisma.match.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(created).toMatchObject({
      status: "WAITING_FOR_OPPONENT",
      player1Id: bob.id,
      inviteeId: alice.id,
      startingStack: original.startingStack,
      smallBlind: original.smallBlind,
      bigBlind: original.bigBlind,
      turnTimeoutSeconds: original.turnTimeoutSeconds,
      maxDiscard: original.maxDiscard,
    });
    expect(res.json().joinToken).toBeTruthy();
    expect((await wallet(bob)).blocked).toBe(150); // reservó su entrada

    // La mesa terminada le ofrece la revancha a Alice, y le muestra a Bob que es suya.
    expect((await view(matchId, alice)).rematch).toEqual({ matchId: created.id, status: "WAITING_FOR_OPPONENT", requestedByYou: false });
    expect((await view(matchId, bob)).rematch).toMatchObject({ requestedByYou: true });
  });

  it("pedirla cuando el rival ya la pidió la acepta: empieza la mano en la MISMA partida", async () => {
    const { matchId, alice, bob } = await finishedMatch();
    const offered = (await rematch(matchId, bob)).json();

    const accepted = await rematch(matchId, alice);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().id).toBe(offered.id);
    expect(accepted.json().status).toBe("IN_PROGRESS");

    const table = await view(offered.id, alice);
    expect(table.handNumber).toBe(1);
    expect(table.you.cards).toHaveLength(5);
    expect((await view(matchId, bob)).rematch.status).toBe("IN_PROGRESS");
    expect(await prisma.match.count()).toBe(2); // la original y una sola revancha
  });

  it("pedirla otra vez no crea otra: devuelve la misma (antes y después de aceptada)", async () => {
    const { matchId, alice, bob } = await finishedMatch();
    const first = (await rematch(matchId, bob)).json();
    expect((await rematch(matchId, bob)).json().id).toBe(first.id);
    await rematch(matchId, alice);
    expect((await rematch(matchId, alice)).json().id).toBe(first.id);
    expect((await rematch(matchId, bob)).json().id).toBe(first.id);
    expect(await prisma.match.count()).toBe(2);
  });

  it("si los dos la piden a la vez, se crea una sola y queda en curso", async () => {
    const { matchId, alice, bob } = await finishedMatch();
    const [a, b] = await Promise.all([rematch(matchId, alice), rematch(matchId, bob)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: a.json().id } })).status).toBe("IN_PROGRESS");
    expect(await prisma.match.count()).toBe(2);
  });

  it("si quien la pidió la cancela, el rival puede pedir una nueva (y la mesa terminada se entera)", async () => {
    const { matchId, alice, bob } = await finishedMatch();
    const offered = (await rematch(matchId, bob)).json();
    await app.inject({ method: "POST", url: `/v1/matches/${offered.id}/resign`, headers: authHeaders(bob) });
    expect((await view(matchId, alice)).rematch.status).toBe("CANCELLED");
    expect((await wallet(bob)).blocked).toBe(0); // se le devolvió la entrada

    const second = await rematch(matchId, alice);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(offered.id);
    expect((await view(matchId, bob)).rematch).toMatchObject({ matchId: second.json().id, requestedByYou: false });
  });

  it("sin saldo para la entrada responde 422 y no crea nada", async () => {
    const { matchId, alice } = await finishedMatch();
    await prisma.player.update({ where: { id: alice.id }, data: { fictionalBalance: 100 } });
    const res = await rematch(matchId, alice);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("INSUFFICIENT_STACK");
    expect(await prisma.match.count()).toBe(1);
  });

  it("solo para partidas terminadas y solo para sus jugadores", async () => {
    const alice = await registerPlayer(app, "alice-guard");
    const bob = await registerPlayer(app, "bob-guard");
    const stranger = await registerPlayer(app, "stranger-guard");
    const created = (
      await app.inject({ method: "POST", url: "/v1/matches", headers: authHeaders(alice), payload: { ...RULES, inviteeId: bob.id } })
    ).json();
    expect((await rematch(created.id, alice)).statusCode).toBe(400); // todavía esperando rival

    await app.inject({ method: "POST", url: `/v1/matches/${created.id}/join`, headers: authHeaders(bob), payload: { joinToken: created.joinToken } });
    expect((await rematch(created.id, alice)).statusCode).toBe(400); // en curso
    await app.inject({ method: "POST", url: `/v1/matches/${created.id}/resign`, headers: authHeaders(alice) });
    expect((await rematch(created.id, stranger)).statusCode).toBe(403);
  });
});
