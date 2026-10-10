/**
 * Información de la mano y juego justo (regresión de AUD-03, AUD-07, AUD-08, AUD-10, AUD-11 y AUD-13).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { shuffleWithSeed } from "../../src/domain/deck.js";
import { formatCard } from "../../src/domain/card.js";
import { act, bearer, expireCurrentTurn, makePlayer, resign, startMatch, view, type AuditPlayer } from "../helpers/scenario.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function step(matchId: string, p: AuditPlayer, body: Record<string, unknown>, key?: string) {
  const v = await view(app, matchId, p);
  const res = await act(app, matchId, p, { ...body, actionVersion: v.stateVersion }, key);
  expect(res.statusCode, res.body).toBe(200);
}

const handAudit = async (matchId: string, p: AuditPlayer, n: number) =>
  (await app.inject({ method: "GET", url: `/v1/matches/${matchId}/hands/${n}`, headers: bearer(p) })).json();

/** Lo que haría un cliente: rearmar el mazo con la semilla revelada y aplicar los descartes en orden. */
function reconstructFinalHands(audit: {
  deckSeed: string;
  dealerPlayerId: string;
  player1Id: string;
  player2Id: string;
  actions: Array<{ playerId: string; type: string; discardedIndexes: number[] }>;
}): Record<string, string[]> {
  const deck = shuffleWithSeed(audit.deckSeed).map(formatCard);
  const otherId = audit.dealerPlayerId === audit.player1Id ? audit.player2Id : audit.player1Id;
  const hands: Record<string, string[]> = { [audit.dealerPlayerId]: deck.slice(0, 5), [otherId]: deck.slice(5, 10) };
  let cursor = 10;
  for (const a of audit.actions) {
    if (a.type !== "DRAW") continue;
    for (const idx of a.discardedIndexes) hands[a.playerId]![idx] = deck[cursor++]!;
  }
  return hands;
}

describe("muck y semilla (AUD-03, AUD-07)", () => {
  it("tras un fold nadie puede rearmar la mano retirada mientras dura la partida; la semilla llega al terminarla", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob); // mano 1: Alice es botón

    const commitment = (await view(app, m, alice)).deckCommitment as string;
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    await step(m, alice, { type: "BET", amount: 20 });
    await step(m, bob, { type: "BET", amount: 0 });
    await step(m, alice, { type: "DRAW", discardedIndexes: [0, 1] });
    await step(m, bob, { type: "DRAW", discardedIndexes: [2, 4] });
    await step(m, alice, { type: "BET", amount: 40 });
    const bobFinal = (await prisma.hand.findUniqueOrThrow({ where: { matchId_number: { matchId: m, number: 1 } } }))
      .player2Cards as string[];
    await step(m, bob, { type: "FOLD" });

    const during = await handAudit(m, alice, 1);
    expect(during.winReason).toBe("FOLD");
    expect(during.revealedCards).toBeNull();
    expect(during.deckSeed).toBeNull(); // sin semilla no hay forma de rearmar las cartas de Bob
    expect(during.deckCommitment).toBe(commitment);

    // Al terminar la partida se publica y verifica el compromiso del reparto.
    expect((await resign(app, m, bob)).statusCode).toBe(200);
    const after = await handAudit(m, alice, 1);
    expect(createHash("sha256").update(after.deckSeed).digest("hex")).toBe(commitment);
    expect(reconstructFinalHands(after)[bob.id]).toEqual(bobFinal);
  });

  it("el compromiso de la mano en curso está en la vista desde el reparto, antes de cualquier auditoría", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const hand = await prisma.hand.findUniqueOrThrow({ where: { matchId_number: { matchId: m, number: 1 } } });
    const v = await view(app, m, alice);
    expect((await app.inject({ method: "GET", url: `/v1/matches/${m}/hands/1`, headers: bearer(alice) })).statusCode).toBe(400);
    expect(v.deckCommitment).toBe(hand.deckCommitment);
    expect(JSON.stringify(v)).not.toContain(hand.deckSeed);
    const dealt = await prisma.gameEvent.findFirstOrThrow({ where: { matchId: m, type: "hand.dealt" } });
    expect(dealt.publicPayload).toMatchObject({ deckCommitment: hand.deckCommitment });
  });
});

describe("cuántas cartas cambió el rival (AUD-08)", () => {
  it("la vista lo muestra en cuanto el rival hace su draw, y queda el evento draw.completed", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    await step(m, alice, { type: "BET", amount: 20 });
    await step(m, bob, { type: "BET", amount: 0 });
    expect((await view(app, m, bob)).opponent.discardedCount).toBeNull();
    await step(m, alice, { type: "DRAW", discardedIndexes: [0, 2, 4] });

    const v = await view(app, m, bob); // turno de Bob en DRAW: Alice ya cambió 3
    expect(v.phase).toBe("DRAW");
    expect(v.opponent.discardedCount).toBe(3);
    const events = await prisma.gameEvent.findMany({ where: { matchId: m, type: "draw.completed" } });
    expect(events.map((e) => e.publicPayload)).toEqual([{ playerId: alice.id, discardedCount: 3, auto: false }]);
  });
});

describe("registro de acciones y eventos (AUD-10)", () => {
  it("cada acción guarda su Idempotency-Key y el estado posterior; quedan betting.updated y turn.started", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const key = randomUUID();
    await step(m, alice, { type: "BET", amount: 20 }, key);
    await step(m, bob, { type: "BET", amount: 0 });
    await step(m, alice, { type: "DRAW", discardedIndexes: [1] });

    const actions = await prisma.action.findMany({ where: { matchId: m }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(actions[0]!.idempotencyKey).toBe(key);
    // Estado anterior = actionVersion; posterior = stateAfter, ya con las transiciones que provocó.
    expect(actions[0]!.stateAfter).toMatchObject({ stateVersion: actions[0]!.actionVersion + 1, phase: "BETTING_PRE_DRAW", pot: 40 });
    expect(actions[1]!.stateAfter).toMatchObject({ phase: "DRAW", pot: 40, stacks: { player1: 980, player2: 980 } });
    expect(actions[2]!.stateAfter).toMatchObject({ phase: "DRAW" });

    const types = (await prisma.gameEvent.findMany({ where: { matchId: m }, orderBy: { occurredAt: "asc" } })).map((e) => e.type);
    expect(types.filter((t) => t === "betting.updated")).toHaveLength(2);
    expect(types.filter((t) => t === "draw.completed")).toHaveLength(1);
    // Un turno por cada vez que cambió quién actúa: reparto, call, check (→ DRAW) y draw.
    expect(types.filter((t) => t === "turn.started")).toHaveLength(4);
  });

  it("las acciones automáticas también guardan su estado posterior", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    await expireCurrentTurn(m);
    await view(app, m, bob); // la lectura resuelve el turno vencido: fold automático de Alice
    const auto = await prisma.action.findFirstOrThrow({ where: { matchId: m, isAuto: true } });
    expect(auto.idempotencyKey).toBeNull();
    expect(auto.stateAfter).toMatchObject({ handNumber: 2 });
  });
});

describe("all-in: no hay más apuestas (AUD-11)", () => {
  it("si uno quedó all-in en la ronda inicial, tras el draw se va directo a showdown", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    // Mano 1: Alice (botón) se retira → Alice 990, Bob 1010.
    await step(m, alice, { type: "FOLD" });
    // Mano 2: Bob es botón. Bob iguala, Alice va all-in por 990, Bob iguala y le quedan 20.
    await step(m, bob, { type: "BET", amount: 20 });
    await step(m, alice, { type: "ALL_IN" });
    await step(m, bob, { type: "BET", amount: 990 });
    await step(m, bob, { type: "DRAW", discardedIndexes: [] });
    await step(m, alice, { type: "DRAW", discardedIndexes: [] });

    const hand2 = await prisma.hand.findUniqueOrThrow({ where: { matchId_number: { matchId: m, number: 2 } } });
    expect(hand2.phase).toBe("HAND_FINISHED");
    expect(["SHOWDOWN", "SPLIT"]).toContain(hand2.winReason);
    const actions = await prisma.action.count({ where: { handId: hand2.id } });
    expect(actions).toBe(5); // ninguna apuesta post-draw
  });

  it("el que queda con fichas tras devolverle el excedente ya no figura all-in (AUD-21)", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    await step(m, alice, { type: "FOLD" }); // Alice 990, Bob 1010
    await step(m, bob, { type: "ALL_IN" }); // Bob (botón) va all-in por 1010
    await step(m, alice, { type: "ALL_IN" }); // Alice iguala con 990: a Bob se le devuelven 20
    const hand2 = await prisma.hand.findUniqueOrThrow({ where: { matchId_number: { matchId: m, number: 2 } } });
    const bobIsP1 = (await prisma.match.findUniqueOrThrow({ where: { id: m } })).player1Id === bob.id;
    expect(bobIsP1 ? hand2.player1AllIn : hand2.player2AllIn).toBe(false);
    expect(bobIsP1 ? hand2.player2AllIn : hand2.player1AllIn).toBe(true);
  });
});

describe("resultado de la última mano en la vista (AUD-13)", () => {
  it("tras un fold, la vista dice quién ganó, quién se retiró y el neto de cada uno", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    await step(m, alice, { type: "FOLD" });

    const forBob = await view(app, m, bob);
    expect(forBob.lastHand).toEqual({
      number: 1,
      winnerId: bob.id,
      winReason: "FOLD",
      pot: 30,
      payout: { you: 30, opponent: 0 },
      net: 10,
      folderId: alice.id,
      timedOut: false,
    });
    expect((await view(app, m, alice)).lastHand).toMatchObject({ winnerId: bob.id, net: -10, payout: { you: 0, opponent: 30 } });
  });

  it("un fold por tiempo agotado se distingue de uno voluntario", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    await expireCurrentTurn(m);
    const v = await view(app, m, bob);
    expect(v.lastHand).toMatchObject({ number: 1, folderId: alice.id, timedOut: true });
  });

  it("la mano que cierra la partida también aparece como lastHand", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob, { startingStack: 100, smallBlind: 10, bigBlind: 20 });
    await step(m, alice, { type: "ALL_IN" });
    await step(m, bob, { type: "ALL_IN" });
    await step(m, alice, { type: "DRAW", discardedIndexes: [] });
    await step(m, bob, { type: "DRAW", discardedIndexes: [] });

    const v = await view(app, m, alice);
    if (v.status === "MATCH_FINISHED") {
      expect(v.lastHand).toMatchObject({ number: 1, pot: 200 });
      expect(v.lastHand.revealedCards.you).toHaveLength(5);
      expect(v.lastHand.revealedCards.opponent).toHaveLength(5);
    } else {
      // Empate: se reparte la mano 2, y lastHand es la 1 igual.
      expect(v.lastHand).toMatchObject({ number: 1, winReason: "SPLIT", pot: 200 });
    }
  });
});
