import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { setSeedSourceForTests, shuffleWithSeed } from "../../src/domain/deck.js";
import { compareScores, referenceScore } from "../audit/reference.js";

let app: FastifyInstance;

async function createAndJoinMatch(
  alice: TestPlayer,
  bob: TestPlayer,
  overrides: Partial<{ startingStack: number; smallBlind: number; bigBlind: number }> = {},
) {
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/matches",
    headers: authHeaders(alice),
    payload: {
      startingStack: overrides.startingStack ?? 1000,
      smallBlind: overrides.smallBlind ?? 10,
      bigBlind: overrides.bigBlind ?? 20,
      inviteeId: bob.id,
    },
  });
  expect(createRes.statusCode).toBe(201);
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
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function act(
  matchId: string,
  player: TestPlayer,
  body: Record<string, unknown>,
  idempotencyKey = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/v1/matches/${matchId}/actions`,
    headers: authHeaders(player, idempotencyKey),
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  setSeedSourceForTests(null);
});

/**
 * Una semilla cuya mano 1 NO termina en empate si Alice (botón, cartas 0-4) cambia sus dos primeras
 * (por las cartas 10 y 11) y Bob (cartas 5-9) se planta. Devuelve quién gana según el evaluador de
 * referencia, independiente del código del servidor (AUD-23).
 */
function seedWithWinner(): { seed: string; aliceWins: boolean } {
  for (let i = 0; ; i++) {
    const seed = createHash("sha256").update(`fullHand-${i}`).digest("hex");
    const deck = shuffleWithSeed(seed);
    const alice = [deck[10]!, deck[11]!, deck[2]!, deck[3]!, deck[4]!];
    const bob = deck.slice(5, 10);
    const cmp = compareScores(referenceScore(alice), referenceScore(bob));
    if (cmp !== 0) return { seed, aliceWins: cmp > 0 };
  }
}

afterAll(async () => {
  await app?.close();
});

describe("flujo completo de partida", () => {
  it("permite consultar la partida mientras espera al rival, sin cartas ni oponente (regresión)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice-waiting");
    const bob = await registerPlayer(app, "bob-waiting");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    expect(createRes.statusCode).toBe(201);
    const match = createRes.json();

    const view = await getView(match.id, alice);
    expect(view.status).toBe("WAITING_FOR_OPPONENT");
    expect(view.opponent).toBeNull();
    expect(view.you.cards).toEqual([]);
    expect(view.phase).toBeNull();
    expect(view.turn).toBeNull();
  });

  it("crea, une y reparte la primera mano con ciegas y cartas privadas (criterios 1-2)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice");
    const bob = await registerPlayer(app, "bob");
    const matchId = await createAndJoinMatch(alice, bob);

    const aliceView = await getView(matchId, alice);
    const bobView = await getView(matchId, bob);

    expect(aliceView.status).toBe("IN_PROGRESS");
    expect(aliceView.handNumber).toBe(1);
    expect(aliceView.you.cards).toHaveLength(5);
    expect(aliceView.opponent.cardCount).toBe(5);
    expect(aliceView.opponent.cards).toBeUndefined();
    expect(bobView.you.cards).toHaveLength(5);
    // Ciegas 10/20 ya descontadas del pozo
    expect(aliceView.pot).toBe(30);
  });

  it("juega una mano completa: pre-draw, draw, post-draw y showdown (criterios 3-5, 9)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice2");
    const bob = await registerPlayer(app, "bob2");
    // Mazo fijado: se puede afirmar quién gana y cuánto cobra, no solo que hubo showdown (AUD-23).
    const { seed, aliceWins } = seedWithWinner();
    setSeedSourceForTests(() => seed);
    const matchId = await createAndJoinMatch(alice, bob);
    const winner = aliceWins ? alice : bob;

    let view = await getView(matchId, alice);
    expect(view.phase).toBe("BETTING_PRE_DRAW");
    // El compromiso se publica desde el reparto, antes que la semilla (AUD-07).
    const commitment = view.deckCommitment as string;
    expect(commitment).toBe(createHash("sha256").update(seed).digest("hex"));
    expect(view.turn.playerId).toBe(alice.id); // el botón actúa primero

    // Alice (botón/ciega chica) iguala la ciega grande.
    let res = await act(matchId, alice, { type: "BET", amount: 20, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    expect(view.legalActions.map((a: { type: string }) => a.type)).toContain("CHECK");

    // Bob cierra la ronda con check.
    res = await act(matchId, bob, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, alice);
    expect(view.phase).toBe("DRAW");
    expect(view.turn.playerId).toBe(alice.id);

    res = await act(matchId, alice, { type: "DRAW", discardedIndexes: [0, 1], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    expect(view.turn.playerId).toBe(bob.id);
    res = await act(matchId, bob, { type: "DRAW", discardedIndexes: [], actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, alice);
    expect(view.phase).toBe("BETTING_POST_DRAW");
    expect(view.turn.playerId).toBe(alice.id);

    res = await act(matchId, alice, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    view = await getView(matchId, bob);
    res = await act(matchId, bob, { type: "BET", amount: 0, actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    // El showdown liquidó la mano y automáticamente repartió la siguiente (handNumber avanzó).
    view = await getView(matchId, alice);
    expect(view.handNumber).toBe(2);
    expect(view.status).toBe("IN_PROGRESS");
    // Pozo de 40 (20 + 20) entero al ganador: neto +20 para él, −20 para el otro (AUD-13: lastHand).
    expect(view.lastHand).toMatchObject({
      number: 1,
      winnerId: winner.id,
      winReason: "SHOWDOWN",
      pot: 40,
      net: aliceWins ? 20 : -20,
      payout: { you: aliceWins ? 40 : 0, opponent: aliceWins ? 0 : 40 },
      folderId: null,
    });
    expect(view.lastHand.revealedCards.you).toHaveLength(5);
    // Mano 2: el botón pasa a Bob (ciega chica 10); Alice pone la grande (20).
    const aliceTotal = view.you.stack + view.you.contribution;
    expect(aliceTotal).toBe(aliceWins ? 1020 : 980);

    const summariesRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(summariesRes.statusCode).toBe(200);
    const summaries = summariesRes.json();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      winReason: "SHOWDOWN",
      winnerId: winner.id,
      payoutPlayer1: aliceWins ? 40 : 0,
      payoutPlayer2: aliceWins ? 0 : 40,
    });

    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands/1`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const audit = auditRes.json();
    // La semilla no se publica mientras siga la partida (AUD-03); el compromiso sí.
    expect(audit.deckSeed).toBeNull();
    expect(audit.deckCommitment).toBe(commitment);
    expect(audit.actions.length).toBeGreaterThan(0);
    // player1Id/player2Id permiten al cliente saber qué mano revelada es la suya en el showdown.
    expect([audit.player1Id, audit.player2Id].sort()).toEqual([alice.id, bob.id].sort());
    expect(audit.revealedCards).toHaveProperty("player1");
    expect(audit.revealedCards).toHaveProperty("player2");

    // Al terminar la partida se revela, y coincide con el compromiso publicado al repartir.
    const resign = await app.inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: authHeaders(bob) });
    expect(resign.statusCode).toBe(200);
    const finalAudit = (
      await app.inject({ method: "GET", url: `/v1/matches/${matchId}/hands/1`, headers: { authorization: `Bearer ${alice.token}` } })
    ).json();
    expect(finalAudit.deckSeed).toBe(seed);
    expect(createHash("sha256").update(finalAudit.deckSeed).digest("hex")).toBe(commitment);
  });

  it("un fold entrega el pozo al rival sin showdown (caso de terminación)", async () => {
    app = await createTestApp();
    const alice = await registerPlayer(app, "alice3");
    const bob = await registerPlayer(app, "bob3");
    const matchId = await createAndJoinMatch(alice, bob);

    const view = await getView(matchId, alice);
    const res = await act(matchId, alice, { type: "FOLD", actionVersion: view.stateVersion });
    expect(res.statusCode).toBe(200);

    const summariesRes = await app.inject({
      method: "GET",
      url: `/v1/matches/${matchId}/hands`,
      headers: { authorization: `Bearer ${bob.token}` },
    });
    const summaries = summariesRes.json();
    expect(summaries[0].winReason).toBe("FOLD");
    expect(summaries[0].winnerId).toBe(bob.id);

    // Cuentas exactas: Bob gana el pozo de 30 (980 + 30 = 1010) y en la mano 2, que se reparte al
    // instante, pone la ciega chica (10). Por eso su stack "visible" vuelve a 1000 aunque ganó +10:
    // hay que sumar lo que ya tiene apostado en la mano nueva.
    const bobView = await getView(matchId, bob);
    expect(bobView.handNumber).toBe(2);
    expect(bobView.you.stack + bobView.you.contribution).toBe(1010);
    expect(bobView.opponent.stack + bobView.opponent.contribution).toBe(990);
    expect(bobView.you.stack + bobView.opponent.stack + bobView.pot).toBe(2000); // ninguna ficha se pierde
  });
});
