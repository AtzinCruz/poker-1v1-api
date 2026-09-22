import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, registerPlayer, authHeaders } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe("GET /v1/invitations", () => {
  it("lista las partidas que invitan al jugador autenticado y desaparece tras unirse", async () => {
    const alice = await registerPlayer(app, "alice-invite");
    const bob = await registerPlayer(app, "bob-invite");

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/matches",
      headers: authHeaders(alice),
      payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
    });
    const match = createRes.json();

    const bobInvites = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(bobInvites.statusCode).toBe(200);
    const invites = bobInvites.json();
    expect(invites).toHaveLength(1);
    expect(invites[0].matchId).toBe(match.id);
    expect(invites[0].joinToken).toBe(match.joinToken);
    expect(invites[0].creatorId).toBe(alice.id);
    expect(invites[0].creatorDisplayName).toBe("alice-invite");
    expect(invites[0].rules).toEqual({ startingStack: 1000, smallBlind: 10, bigBlind: 20 });

    // Alice no tiene invitaciones pendientes (ella es quien invitó, no la invitada).
    const aliceInvites = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(aliceInvites.json()).toEqual([]);

    // Tras unirse, la invitación ya no debe listarse (la partida dejó de estar WAITING_FOR_OPPONENT).
    await app.inject({
      method: "POST",
      url: `/v1/matches/${match.id}/join`,
      headers: authHeaders(bob),
      payload: { joinToken: match.joinToken },
    });
    const afterJoin = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(afterJoin.json()).toEqual([]);
  });

  it("no lista invitaciones de un jugador sin invitaciones", async () => {
    const alice = await registerPlayer(app, "alice-noinvite");
    const res = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
