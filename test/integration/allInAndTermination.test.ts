import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";

let app: FastifyInstance;

async function createAndJoinMatch(
  alice: TestPlayer,
  bob: TestPlayer,
  startingStack: number,
  smallBlind = 10,
  bigBlind = 20,
) {
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/matches",
    headers: authHeaders(alice),
    payload: { startingStack, smallBlind, bigBlind, inviteeId: bob.id },
  });
  const match = createRes.json();
  const joinRes = await app.inject({
    method: "POST",
    url: `/v1/matches/${match.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: match.joinToken },
  });
  expect(joinRes.statusCode).toBe(200);
  return match.id as string;
}

async function getView(matchId: string, player: TestPlayer) {
  const res = await app.inject({
    method: "GET",
    url: `/v1/matches/${matchId}`,
    headers: { authorization: `Bearer ${player.token}` },
  });
  return res.json();
}

async function act(matchId: string, player: TestPlayer, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/matches/${matchId}/actions`,
    headers: authHeaders(player),
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe("all-in y terminación de sesión", () => {
  it("un all-in parcial se resuelve, reembolsa el excedente y llega a showdown sin más apuestas", async () => {
    const alice = await registerPlayer(app, "alice-allin");
    const bob = await registerPlayer(app, "bob-allin");
    const matchId = await createAndJoinMatch(alice, bob, 100, 10, 20);
    // Ambos arrancan con el mismo startingStack (regla de la partida); forzamos a Bob corto
    // de fichas directamente en la base para poder probar el all-in parcial y su reembolso:
    // Bob ya posteó la ciega grande (20), le dejamos 20 de stack → 40 fichas totales.
    await prisma.match.update({ where: { id: matchId }, data: { player2Stack: 20 } });

    let view = await getView(matchId, alice);
    expect(view.turn.playerId).toBe(alice.id);

    // Alice va all-in con sus 100 fichas totales.
    let res = await act(matchId, alice, { type: "ALL_IN", actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    const legalTypes = view.legalActions.map((a: { type: string }) => a.type);
    expect(legalTypes).toContain("ALL_IN");

    // Bob también va all-in (con lo que le queda, que es menos que el all-in de Alice).
    res = await act(matchId, bob, { type: "ALL_IN", actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    // Ambos quedaron all-in, pero el draw sigue existiendo: cada quien descarta igual.
    view = await getView(matchId, alice);
    expect(view.phase).toBe("DRAW");
    expect(view.turn.playerId).toBe(alice.id);
    res = await act(matchId, alice, { type: "DRAW", discardedIndexes: [], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    res = await act(matchId, bob, { type: "DRAW", discardedIndexes: [], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    // Ambos all-in: no hay más apuestas posibles en post-draw, se resuelve directo a showdown.
    view = await getView(matchId, alice);
    expect(view.status === "IN_PROGRESS" || view.status === "MATCH_FINISHED").toBe(true);
    if (view.status === "IN_PROGRESS") {
      expect(view.handNumber).toBe(2);
    }

    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands/1`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const audit = auditRes.json();
    expect(["SHOWDOWN", "SPLIT"]).toContain(audit.winReason);
    // Bob solo podía cubrir 40 en total; Alice no debería perder más de eso en el pozo.
    expect(audit.pot).toBeLessThanOrEqual(80);
  });

  it("termina la partida cuando un jugador no puede cubrir la ciega grande de la siguiente mano (criterio 15)", async () => {
    const alice = await registerPlayer(app, "alice-broke");
    const bob = await registerPlayer(app, "bob-broke");
    // startingStack respeta el mínimo del contrato (100); simulamos que Alice ya viene muy
    // corta de manos anteriores directamente en la base, para forzar el caso límite sin
    // depender del resultado aleatorio de un showdown.
    const matchId = await createAndJoinMatch(alice, bob, 100, 10, 20);
    await prisma.match.update({ where: { id: matchId }, data: { player1Stack: 15 } });

    const view = await getView(matchId, alice);
    const res = await act(matchId, alice, { type: "FOLD", actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    const finalView = await getView(matchId, bob);
    // Alice quedó con 15 fichas, insuficientes para cubrir la ciega grande (20) de la próxima mano.
    expect(finalView.status).toBe("MATCH_FINISHED");
    expect(finalView.finishReason).toBe("INSUFFICIENT_STACK");
    expect(finalView.winnerId).toBe(bob.id);

    // El saldo ficticio se liquidó: el saldo bloqueado se liberó para ambos jugadores.
    const walletRes = await app.inject({
      method: "GET",
      url: "/v1/wallet",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    const wallet = walletRes.json();
    expect(wallet.blocked).toBe(0);
    expect(wallet.available).toBeGreaterThan(1000 - 25); // ganó fichas de Alice
  });
});
