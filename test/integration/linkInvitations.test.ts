/**
 * Invitación por enlace: la partida se crea sin invitado y se une quien abra el enlace (que lleva el
 * joinToken). Sin el token no se ve ni se puede unir nadie.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { bearer, cmd, makePlayer, view, walletOf, type AuditPlayer } from "../helpers/scenario.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function createLinkMatch(creator: AuditPlayer, body: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/v1/matches", headers: cmd(creator), payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; joinToken: string };
}

const preview = (p: AuditPlayer, matchId: string, joinToken: string) =>
  app.inject({ method: "POST", url: "/v1/invitations/preview", headers: bearer(p), payload: { matchId, joinToken } });

const join = (p: AuditPlayer, matchId: string, joinToken: string) =>
  app.inject({ method: "POST", url: `/v1/matches/${matchId}/join`, headers: cmd(p), payload: { joinToken } });

describe("invitación por enlace", () => {
  it("sin inviteeId la partida espera a quien abra el enlace; cualquiera con el token puede unirse", async () => {
    const ana = await makePlayer("ana");
    const beto = await makePlayer("beto");
    const { id, joinToken } = await createLinkMatch(ana);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).inviteeId).toBeNull();

    const seen = await preview(beto, id, joinToken);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      matchId: id,
      status: "WAITING_FOR_OPPONENT",
      creatorDisplayName: ana.displayName,
      rules: { startingStack: 300, smallBlind: 10, bigBlind: 20 },
      youAreIn: false,
      canJoin: true,
    });
    // Ver la invitación no reserva nada: unirse sí.
    expect(await walletOf(beto)).toEqual({ available: 1000, blocked: 0 });

    expect((await join(beto, id, joinToken)).statusCode).toBe(200);
    expect(await walletOf(beto)).toEqual({ available: 700, blocked: 300 });
    const v = await view(app, id, beto);
    expect(v.status).toBe("IN_PROGRESS");
    expect(v.opponent.displayName).toBe(ana.displayName);
  });

  it("sin el token correcto: 404 al verla y 403 al unirse, esté como esté la partida", async () => {
    const ana = await makePlayer("ana");
    const beto = await makePlayer("beto");
    const eve = await makePlayer("eve");
    const { id, joinToken } = await createLinkMatch(ana);

    expect((await preview(eve, id, "token-adivinado")).statusCode).toBe(404);
    expect((await preview(eve, "no-existe", joinToken)).statusCode).toBe(404);
    expect((await join(eve, id, "token-adivinado")).statusCode).toBe(403);

    expect((await join(beto, id, joinToken)).statusCode).toBe(200);
    // Ya empezada: sin token sigue siendo 403 (no se distingue en espera de en curso); con token, 400.
    expect((await join(eve, id, "token-adivinado")).statusCode).toBe(403);
    expect((await join(eve, id, joinToken)).statusCode).toBe(400);
    const late = await preview(eve, id, joinToken);
    expect(late.json()).toMatchObject({ status: "IN_PROGRESS", youAreIn: false, canJoin: false });
  });

  it("quien la creó ve su propio enlace como suyo y no puede unirse a sí misma", async () => {
    const ana = await makePlayer("ana");
    const { id, joinToken } = await createLinkMatch(ana);
    expect((await preview(ana, id, joinToken)).json()).toMatchObject({ youAreIn: true, canJoin: false });
    expect((await join(ana, id, joinToken)).statusCode).toBe(400);
  });

  it("solo quien la creó recibe el token en la vista, y solo mientras espera rival", async () => {
    const ana = await makePlayer("ana");
    const beto = await makePlayer("beto");
    const { id, joinToken } = await createLinkMatch(ana);
    expect((await view(app, id, ana)).linkInvitation).toEqual({ joinToken });

    expect((await join(beto, id, joinToken)).statusCode).toBe(200);
    expect((await view(app, id, ana)).linkInvitation).toBeNull();
    expect((await view(app, id, beto)).linkInvitation).toBeNull();
  });

  it("no aparece en las invitaciones de nadie y en «Tus partidas» figura como invitación por enlace", async () => {
    const ana = await makePlayer("ana");
    const beto = await makePlayer("beto");
    const { id } = await createLinkMatch(ana);
    const invitations = await app.inject({ method: "GET", url: "/v1/invitations", headers: bearer(beto) });
    expect(invitations.json()).toEqual([]);
    const mine = await app.inject({ method: "GET", url: "/v1/matches", headers: bearer(ana) });
    expect(mine.json()).toEqual([expect.objectContaining({ matchId: id, opponentName: null, inviteByLink: true })]);
  });

  it("la invitación a un jugador concreto sigue siendo solo para él aunque otro tenga el token", async () => {
    const ana = await makePlayer("ana");
    const beto = await makePlayer("beto");
    const eve = await makePlayer("eve");
    const { id, joinToken } = await createLinkMatch(ana, { inviteeId: beto.id });
    expect((await preview(eve, id, joinToken)).json()).toMatchObject({ canJoin: false });
    expect((await join(eve, id, joinToken)).statusCode).toBe(403);
    expect((await preview(beto, id, joinToken)).json()).toMatchObject({ canJoin: true });
  });
});
