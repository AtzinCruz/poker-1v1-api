import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createTestApp, registerPlayer, authHeaders, type TestPlayer } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { dealNewHand } from "../../src/application/dealing.js";
import { expireStaleInvitations, sweepExpiredTurns } from "../../src/application/maintenance.js";
import { MAX_FICTIONAL_BALANCE } from "../../src/application/adminService.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

async function createMatch(alice: TestPlayer, bob: TestPlayer, rules = { startingStack: 1000, smallBlind: 10, bigBlind: 20 }) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/matches",
    headers: authHeaders(alice),
    payload: { ...rules, inviteeId: bob.id },
  });
  return res;
}

async function startMatch(alice: TestPlayer, bob: TestPlayer): Promise<string> {
  const created = (await createMatch(alice, bob)).json();
  const joined = await app.inject({
    method: "POST",
    url: `/v1/matches/${created.id}/join`,
    headers: authHeaders(bob),
    payload: { joinToken: created.joinToken },
  });
  expect(joined.statusCode).toBe(200);
  return created.id as string;
}

async function view(matchId: string, player: TestPlayer) {
  const res = await app.inject({
    method: "GET",
    url: `/v1/matches/${matchId}`,
    headers: { authorization: `Bearer ${player.token}` },
  });
  expect(res.statusCode).toBe(200);
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

async function wallet(player: TestPlayer) {
  const res = await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${player.token}` } });
  return res.json() as { available: number; blocked: number };
}

async function totalChips(...players: TestPlayer[]) {
  let total = 0;
  for (const p of players) {
    const w = await wallet(p);
    total += w.available + w.blocked;
  }
  return total;
}

/** Simula que pasó el plazo del turno en curso (el cliente real tarda 60 s; el test lo adelanta). */
async function expireCurrentTurn(matchId: string) {
  await prisma.hand.updateMany({
    where: { matchId, phase: { in: ["DRAW", "BETTING_PRE_DRAW", "BETTING_POST_DRAW"] } },
    data: { turnExpiresAt: new Date(Date.now() - 1000) },
  });
}

describe("resign y timeouts (críticos #1, #2)", () => {
  it("abandonar cierra la mano: un turno vencido no resucita la partida ni paga dos veces", async () => {
    const alice = await registerPlayer(app, "alice-zombie");
    const bob = await registerPlayer(app, "bob-zombie");
    const matchId = await startMatch(alice, bob);

    const resign = await app.inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: authHeaders(alice) });
    expect(resign.statusCode).toBe(200);

    const hand = await prisma.hand.findFirstOrThrow({ where: { matchId } });
    expect(hand.phase).toBe("HAND_FINISHED");
    expect(hand.toActPlayerId).toBeNull();
    expect(hand.turnExpiresAt).toBeNull();

    // Reproduce el estado defectuoso original: mano "viva" con turno vencido. La partida terminada
    // jamás debe reanudarse por eso.
    await prisma.hand.update({
      where: { id: hand.id },
      data: { phase: "BETTING_PRE_DRAW", toActPlayerId: alice.id, turnExpiresAt: new Date(Date.now() - 5000) },
    });

    expect((await view(matchId, bob)).status).toBe("MATCH_FINISHED");
    await sweepExpiredTurns();
    expect((await view(matchId, alice)).status).toBe("MATCH_FINISHED");

    // Una sola liquidación: entraron 2000 fichas y siguen siendo 2000.
    expect(await totalChips(alice, bob)).toBe(2000);
    expect(await wallet(bob)).toMatchObject({ available: 2000, blocked: 0 });
  });

  it("abandonar entrega al rival el pozo y ambos stacks: no se destruyen fichas", async () => {
    const alice = await registerPlayer(app, "alice-forfeit");
    const bob = await registerPlayer(app, "bob-forfeit");
    const matchId = await startMatch(alice, bob);

    // Mano en curso con apuestas: Alice iguala 20 (pozo 40).
    const v = await view(matchId, alice);
    expect((await act(matchId, alice, { type: "BET", amount: 20, actionVersion: v.stateVersion })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: authHeaders(bob) });

    expect(await totalChips(alice, bob)).toBe(2000);
    expect(await wallet(alice)).toMatchObject({ available: 2000, blocked: 0 });
    expect(await wallet(bob)).toMatchObject({ available: 0, blocked: 0 });
    const final = await view(matchId, alice);
    expect(final.finishReason).toBe("RESIGN");
    expect(final.winnerId).toBe(alice.id);
  });
});

describe("concurrencia al vencer un turno (crítico #3)", () => {
  it("lecturas simultáneas de un turno vencido aplican la acción automática una sola vez", async () => {
    const alice = await registerPlayer(app, "alice-race");
    const bob = await registerPlayer(app, "bob-race");
    const matchId = await startMatch(alice, bob);

    await expireCurrentTurn(matchId);
    await Promise.all(Array.from({ length: 8 }, (_, i) => view(matchId, i % 2 ? alice : bob)));

    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    // Alice (botón) no respondió frente a la ciega grande → fold automático → una sola mano nueva.
    expect(match.handNumber).toBe(2);
    expect(await prisma.hand.count({ where: { matchId } })).toBe(2);
    expect(await prisma.action.count({ where: { matchId, isAuto: true } })).toBe(1);

    const hand2 = await prisma.hand.findFirstOrThrow({ where: { matchId, number: 2 } });
    expect(match.player1Stack! + match.player2Stack! + hand2.player1Contribution + hand2.player2Contribution).toBe(2000);
  });
});

describe("actionVersion protege dentro de una mano (alto #4)", () => {
  it("cada apuesta, check y draw sube stateVersion, y una acción con versión vieja da 409", async () => {
    const alice = await registerPlayer(app, "alice-version");
    const bob = await registerPlayer(app, "bob-version");
    const matchId = await startMatch(alice, bob);

    const versions: number[] = [(await view(matchId, alice)).stateVersion];
    const play = async (player: TestPlayer, body: Record<string, unknown>) => {
      const v = await view(matchId, player);
      const res = await act(matchId, player, { ...body, actionVersion: v.stateVersion });
      expect(res.statusCode).toBe(200);
      versions.push((await view(matchId, player)).stateVersion);
      return v.stateVersion as number;
    };

    const staleForBob = await play(alice, { type: "BET", amount: 20 }); // call
    await play(bob, { type: "BET", amount: 0 }); // check → cierra pre-draw
    await play(alice, { type: "DRAW", discardedIndexes: [] });

    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]!);
    }

    // Bob todavía tiene la pantalla de antes de la apuesta de Alice: su acción vieja se rechaza.
    const late = await act(matchId, bob, { type: "BET", amount: 0, actionVersion: staleForBob });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("STALE_STATE");
  });
});

describe("autenticación (altos #5, #9; medio #10)", () => {
  async function adminToken(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/admin-session",
      payload: { displayName: "admin", secret: process.env.ADMIN_SECRET },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token;
  }

  it("un token de admin no se acepta como token de jugador (no filtra invitaciones ni join tokens)", async () => {
    const alice = await registerPlayer(app, "alice-aud");
    const bob = await registerPlayer(app, "bob-aud");
    await createMatch(alice, bob);
    const token = await adminToken();

    for (const url of ["/v1/invitations", "/v1/wallet"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("conocer solo JWT_SECRET no alcanza para fabricar un token de admin", async () => {
    const secret = process.env.JWT_SECRET!;
    const forged = [
      jwt.sign({ admin: true, name: "x" }, secret), // formato original, sin audience
      jwt.sign({ name: "x" }, secret, { audience: "admin" }), // con audience pero firmado con JWT_SECRET
      jwt.sign({ admin: true, name: "x" }, secret, { audience: "admin", algorithm: "HS384" }),
    ];
    for (const token of forged) {
      const res = await app.inject({ method: "GET", url: "/v1/admin/players", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("un token de jugador sin audience (formato viejo) o con otro algoritmo se rechaza", async () => {
    const alice = await registerPlayer(app, "alice-oldtoken");
    const secret = process.env.JWT_SECRET!;
    const legacy = jwt.sign({ sub: alice.id, displayName: "alice-oldtoken" }, secret);
    const hs512 = jwt.sign({ sub: alice.id, displayName: "x" }, secret, { audience: "player", algorithm: "HS512" });
    for (const token of [legacy, hs512]) {
      const res = await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("el login de admin tiene un límite estricto contra fuerza bruta", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/admin-session",
        payload: { displayName: "admin", secret: `intento-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("validaciones (alto #6, medio #8, bajos)", () => {
  it("rechaza una ciega grande que supera 1/5 del stack inicial (la partida no podría jugarse)", async () => {
    const alice = await registerPlayer(app, "alice-blinds");
    const bob = await registerPlayer(app, "bob-blinds");

    const tooBig = await createMatch(alice, bob, { startingStack: 1000, smallBlind: 500, bigBlind: 1000 });
    expect(tooBig.statusCode).toBe(400);
    const edge = await createMatch(alice, bob, { startingStack: 1000, smallBlind: 100, bigBlind: 201 });
    expect(edge.statusCode).toBe(400);
    const ok = await createMatch(alice, bob, { startingStack: 1000, smallBlind: 100, bigBlind: 200 });
    expect(ok.statusCode).toBe(201);
  });

  it("la misma Idempotency-Key no se puede reusar en otra partida", async () => {
    const alice = await registerPlayer(app, "alice-idem2");
    const bob = await registerPlayer(app, "bob-idem2");
    const carol = await registerPlayer(app, "carol-idem2");
    await prisma.player.update({ where: { id: alice.id }, data: { fictionalBalance: 2000 } }); // dos partidas a la vez
    const matchA = await startMatch(alice, bob);
    const matchB = await startMatch(alice, carol);

    const key = randomUUID();
    const first = await app.inject({ method: "POST", url: `/v1/matches/${matchA}/resign`, headers: authHeaders(alice, key) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/matches/${matchB}/resign`, headers: authHeaders(alice, key) });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("IDEMPOTENCY_CONFLICT");
    // La partida B no fue tocada.
    expect((await view(matchB, alice)).status).toBe("IN_PROGRESS");
  });

  it("handNumber inválido devuelve 400, no 500", async () => {
    const alice = await registerPlayer(app, "alice-nan");
    const bob = await registerPlayer(app, "bob-nan");
    const matchId = await startMatch(alice, bob);
    for (const n of ["abc", "0", "-1", "1.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/matches/${matchId}/hands/${n}`,
        headers: { authorization: `Bearer ${alice.token}` },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("terminación de la partida (medios #11, regla de eliminación)", () => {
  it("el botón también debe cubrir la ciega grande para empezar una mano (no solo la chica)", async () => {
    const alice = await registerPlayer(app, "alice-short");
    const bob = await registerPlayer(app, "bob-short");
    const match = await prisma.match.create({
      data: {
        status: "IN_PROGRESS",
        startingStack: 100,
        smallBlind: 10,
        bigBlind: 20,
        player1Id: alice.id,
        player2Id: bob.id,
        inviteeId: bob.id,
        joinToken: randomUUID(),
        player1Stack: 15, // botón de la próxima mano: alcanza para la chica (10) pero no para la grande (20)
        player2Stack: 185,
      },
    });
    const result = await prisma.$transaction((tx) => dealNewHand(tx, match));
    expect(result.matchFinished).toBe(true);
    expect(result.match.finishReason).toBe("INSUFFICIENT_STACK");
    expect(result.match.winnerId).toBe(bob.id);
  });

  it("tras 3 acciones automáticas seguidas el jugador se da por desconectado y pierde el saldo en juego", async () => {
    const alice = await registerPlayer(app, "alice-gone");
    const bob = await registerPlayer(app, "bob-gone");
    const matchId = await startMatch(alice, bob);

    for (let i = 0; i < 12; i++) {
      const v = await view(matchId, bob);
      if (v.status !== "IN_PROGRESS") break;
      await expireCurrentTurn(matchId);
      await view(matchId, bob);
    }

    const final = await view(matchId, bob);
    expect(final.status).toBe("MATCH_FINISHED");
    expect(final.finishReason).toBe("DISCONNECT_TIMEOUT");
    expect(final.winnerId).toBe(bob.id);
    expect(await totalChips(alice, bob)).toBe(2000);
    expect(await wallet(alice)).toMatchObject({ available: 0, blocked: 0 });
  });

  it("el barrido en segundo plano resuelve turnos vencidos aunque nadie consulte la partida", async () => {
    const alice = await registerPlayer(app, "alice-sweep");
    const bob = await registerPlayer(app, "bob-sweep");
    const matchId = await startMatch(alice, bob);

    await expireCurrentTurn(matchId);
    expect(await sweepExpiredTurns()).toBe(1);

    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).handNumber).toBe(2);
    expect(await sweepExpiredTurns()).toBe(0);
  });

  it("una invitación que nadie acepta se cancela y libera el saldo reservado de su creador", async () => {
    const alice = await registerPlayer(app, "alice-stale-invite");
    const bob = await registerPlayer(app, "bob-stale-invite");
    const created = (await createMatch(alice, bob)).json();
    expect(await wallet(alice)).toMatchObject({ available: 0, blocked: 1000 });

    expect(await expireStaleInvitations(-1)).toBe(1);

    const match = await prisma.match.findUniqueOrThrow({ where: { id: created.id } });
    expect(match.status).toBe("CANCELLED");
    expect(await wallet(alice)).toMatchObject({ available: 1000, blocked: 0 });
  });
});

describe("auditoría de saldo del admin", () => {
  it("cada ajuste deja registro, y no se puede superar el tope del entero de la base", async () => {
    const alice = await registerPlayer(app, "alice-audit");
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/admin-session",
      payload: { displayName: "root", secret: process.env.ADMIN_SECRET },
    });
    const headers = { authorization: `Bearer ${login.json().token}` };

    const ok = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers,
      payload: { amount: 250 },
    });
    expect(ok.statusCode).toBe(200);
    const records = await prisma.adminAction.findMany({ where: { playerId: alice.id } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ adminName: "root", type: "ADD_BALANCE", amount: 250, balanceBefore: 1000, balanceAfter: 1250 });

    await prisma.player.update({ where: { id: alice.id }, data: { fictionalBalance: MAX_FICTIONAL_BALANCE - 100 } });
    const overflow = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${alice.id}/add-balance`,
      headers,
      payload: { amount: 1000 },
    });
    expect(overflow.statusCode).toBe(400);
    expect(await prisma.adminAction.count({ where: { playerId: alice.id } })).toBe(1);
  });
});
