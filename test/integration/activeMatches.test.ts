import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

async function createMatch(creator: TestPlayer, invitee: TestPlayer) {
  return (
    await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(creator),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: invitee.id },
    })
  ).json() as { id: string; joinToken: string };
}

async function join(player: TestPlayer, match: { id: string; joinToken: string }) {
  await app.inject({
    method: "POST",
    url: `/v1/matches/${match.id}/join`,
    headers: authHeaders(player),
    payload: { joinToken: match.joinToken },
  });
}

const myMatches = async (player: TestPlayer) =>
  (await app.inject({ method: "GET", url: "/v1/matches", headers: { authorization: `Bearer ${player.token}` } })).json();

describe("GET /v1/matches (tus partidas abiertas)", () => {
  it("lista las partidas en curso de ambos jugadores con el rival, la mano y de quién es el turno", async () => {
    const alice = await registerPlayer(app, "alice-mine");
    const bob = await registerPlayer(app, "bob-mine");
    const match = await createMatch(alice, bob);
    await join(bob, match);

    const [forAlice] = await myMatches(alice);
    const [forBob] = await myMatches(bob);
    expect(forAlice).toMatchObject({ matchId: match.id, status: "IN_PROGRESS", opponentName: "bob-mine", handNumber: 1 });
    expect(forBob).toMatchObject({ matchId: match.id, opponentName: "alice-mine" });
    // Alice (botón) actúa primero en la mano 1.
    expect(forAlice.yourTurn).toBe(true);
    expect(forBob.yourTurn).toBe(false);
  });

  it("una invitación sin aceptar aparece para quien la creó, con el nombre del invitado", async () => {
    const alice = await registerPlayer(app, "alice-wait");
    const bob = await registerPlayer(app, "bob-wait");
    const match = await createMatch(alice, bob);

    expect(await myMatches(alice)).toEqual([
      expect.objectContaining({ matchId: match.id, status: "WAITING_FOR_OPPONENT", opponentName: "bob-wait", yourTurn: false }),
    ]);
    expect(await myMatches(bob)).toEqual([]); // para el invitado es una invitación, no una partida suya todavía
  });

  it("no incluye partidas terminadas ni canceladas, ni partidas de otros jugadores", async () => {
    const alice = await registerPlayer(app, "alice-x");
    const bob = await registerPlayer(app, "bob-x");
    const carol = await registerPlayer(app, "carol-x");
    const dave = await registerPlayer(app, "dave-x");
    const finished = await createMatch(alice, bob);
    await join(bob, finished);
    await app.inject({ method: "POST", url: `/v1/matches/${finished.id}/resign`, headers: authHeaders(alice) });

    const cancelled = await createMatch(alice, carol);
    await app.inject({ method: "POST", url: `/v1/matches/${cancelled.id}/resign`, headers: authHeaders(alice) });

    const others = await createMatch(carol, dave);
    await join(dave, others);

    expect(await myMatches(alice)).toEqual([]);
    expect((await myMatches(carol)).map((m: { matchId: string }) => m.matchId)).toEqual([others.id]);
  });

  it("exige autenticación", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/matches" })).statusCode).toBe(401);
  });
});
