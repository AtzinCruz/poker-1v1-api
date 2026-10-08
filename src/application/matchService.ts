import { randomBytes } from "node:crypto";
import type { Match, Prisma } from "@prisma/client";
import { prisma } from "../infrastructure/prisma/client.js";
import { withIdempotency } from "../infrastructure/idempotency.js";
import { DomainError } from "../domain/errors.js";
import { dealNewHand } from "./dealing.js";
import { resolveExpiredTurns } from "./timeouts.js";
import { logEvent } from "./events.js";
import { refundReservedStack } from "./walletSettlement.js";
import { finishMatchByForfeit } from "./forfeit.js";
import { lockAndLoadMatch } from "./locks.js";
import { notifyMatchChanged } from "../infrastructure/matchNotifier.js";

export interface CreateMatchInput {
  creatorId: string;
  idempotencyKey: string;
  body: {
    startingStack: number;
    smallBlind: number;
    bigBlind: number;
    turnTimeoutSeconds?: number;
    inviteeId: string;
  };
}

export interface MatchResource {
  id: string;
  status: Match["status"];
  stateVersion: number;
  joinToken?: string;
  rules: { startingStack: number; smallBlind: number; bigBlind: number; maxDiscard: number };
}

function toMatchResource(match: Match, includeJoinToken: boolean): MatchResource {
  return {
    id: match.id,
    status: match.status,
    stateVersion: match.stateVersion,
    ...(includeJoinToken ? { joinToken: match.joinToken } : {}),
    rules: {
      startingStack: match.startingStack,
      smallBlind: match.smallBlind,
      bigBlind: match.bigBlind,
      maxDiscard: match.maxDiscard,
    },
  };
}

export async function createMatch(
  input: CreateMatchInput,
): Promise<{ status: number; body: MatchResource; idempotentReplay: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${input.creatorId} FOR UPDATE`;

    const result = await withIdempotency(
      tx,
      { playerId: input.creatorId, key: input.idempotencyKey, scope: "create-match", requestBody: input.body },
      async () => {
        const { startingStack, smallBlind, bigBlind, turnTimeoutSeconds, inviteeId } = input.body;

        if (inviteeId === input.creatorId) {
          throw new DomainError("INVALID_ACTION", "No puedes invitarte a ti mismo");
        }
        const invitee = await tx.player.findUnique({ where: { id: inviteeId } });
        if (!invitee) {
          throw new DomainError("INVALID_ACTION", "El jugador invitado no existe");
        }

        const creator = await tx.player.findUniqueOrThrow({ where: { id: input.creatorId } });
        if (creator.fictionalBalance < startingStack) {
          throw new DomainError("INSUFFICIENT_STACK", "Saldo ficticio insuficiente para esta entrada");
        }

        await tx.player.update({
          where: { id: input.creatorId },
          data: {
            fictionalBalance: creator.fictionalBalance - startingStack,
            blockedBalance: creator.blockedBalance + startingStack,
          },
        });

        const match = await tx.match.create({
          data: {
            status: "WAITING_FOR_OPPONENT",
            startingStack,
            smallBlind,
            bigBlind,
            turnTimeoutSeconds: turnTimeoutSeconds ?? 60,
            maxDiscard: 5,
            player1Id: input.creatorId,
            inviteeId,
            joinToken: randomBytes(16).toString("hex"),
          },
        });

        return { status: 201, body: toMatchResource(match, true) };
      },
    );

    return { ...result };
  });
}

export interface JoinMatchInput {
  matchId: string;
  playerId: string;
  idempotencyKey: string;
  body: { joinToken: string };
}

export async function joinMatch(
  input: JoinMatchInput,
): Promise<{ status: number; body: MatchResource; idempotentReplay: boolean }> {
  return prisma.$transaction(async (tx) => {
    const match = await lockAndLoadMatch(tx, input.matchId);
    if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe");

    const result = await withIdempotency(
      tx,
      { playerId: input.playerId, key: input.idempotencyKey, scope: `join:${input.matchId}`, requestBody: input.body },
      async () => {
        if (match.status !== "WAITING_FOR_OPPONENT") {
          throw new DomainError("INVALID_ACTION", "La partida ya no acepta un segundo jugador");
        }
        if (match.inviteeId !== input.playerId) {
          throw new DomainError("NOT_MATCH_PLAYER", "Este jugador no fue invitado a esta partida");
        }
        if (match.joinToken !== input.body.joinToken) {
          throw new DomainError("INVALID_ACTION", "Token de invitación inválido");
        }

        await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${input.playerId} FOR UPDATE`;
        const invitee = await tx.player.findUniqueOrThrow({ where: { id: input.playerId } });
        if (invitee.fictionalBalance < match.startingStack) {
          throw new DomainError("INSUFFICIENT_STACK", "Saldo ficticio insuficiente para esta entrada");
        }
        await tx.player.update({
          where: { id: input.playerId },
          data: {
            fictionalBalance: invitee.fictionalBalance - match.startingStack,
            blockedBalance: invitee.blockedBalance + match.startingStack,
          },
        });

        const joined = await tx.match.update({
          where: { id: match.id },
          data: {
            player2Id: input.playerId,
            player1Stack: match.startingStack,
            player2Stack: match.startingStack,
            stateVersion: { increment: 1 },
          },
        });

        const deal = await dealNewHand(tx, joined);
        await notifyMatchChanged(tx, joined.id); // el creador espera en la sala de espera
        return { status: 200, body: toMatchResource(deal.match, false) };
      },
    );

    return { ...result };
  });
}

export interface ResignInput {
  matchId: string;
  playerId: string;
  idempotencyKey: string;
}

export async function resignMatch(
  input: ResignInput,
): Promise<{ status: number; body: MatchResource; idempotentReplay: boolean }> {
  // Paso 1: confirma timeouts vencidos (con el lock de la partida) aunque el resign en sí falle.
  await prisma.$transaction(async (tx) => {
    const match = await lockAndLoadMatch(tx, input.matchId);
    if (!match) return;
    if (match.player1Id !== input.playerId && match.player2Id !== input.playerId) return;
    const hand = match.handNumber > 0
      ? await tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber } } })
      : null;
    await resolveExpiredTurns(tx, match, hand);
  });

  return prisma.$transaction(async (tx) => {
    const match = await lockAndLoadMatch(tx, input.matchId);
    if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe");

    const result = await withIdempotency(
      tx,
      { playerId: input.playerId, key: input.idempotencyKey, scope: `resign:${input.matchId}`, requestBody: {} },
      async () => {
        if (match.player1Id !== input.playerId && match.player2Id !== input.playerId) {
          throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
        }
        if (match.status === "MATCH_FINISHED" || match.status === "CANCELLED") {
          return { status: 200, body: toMatchResource(match, false) };
        }

        let updated: Match;
        if (match.status === "WAITING_FOR_OPPONENT") {
          updated = await cancelWaitingMatch(tx, match);
        } else {
          updated = await finishMatchByForfeit(tx, match, input.playerId, "RESIGN");
        }

        return { status: 200, body: toMatchResource(updated, false) };
      },
    );

    return { ...result };
  });
}

/** Cancela una partida que nadie aceptó y libera la reserva de su creador. */
export async function cancelWaitingMatch(tx: Prisma.TransactionClient, match: Match): Promise<Match> {
  const updated = await tx.match.update({
    where: { id: match.id },
    data: { status: "CANCELLED", stateVersion: { increment: 1 } },
  });
  await refundReservedStack(tx, {
    playerId: updated.player1Id,
    reservedAmount: updated.startingStack,
    finalStack: updated.startingStack,
  });
  await logEvent(tx, {
    matchId: updated.id,
    type: "match.finished",
    stateVersion: updated.stateVersion,
    publicPayload: { reason: "CANCELLED", winnerId: null },
  });
  await notifyMatchChanged(tx, updated.id);
  return updated;
}

export interface Invitation {
  matchId: string;
  joinToken: string;
  creatorId: string;
  creatorDisplayName: string;
  rules: { startingStack: number; smallBlind: number; bigBlind: number };
  createdAt: string;
}

/**
 * Partidas creadas para este jugador (inviteeId) que todavía esperan que se una.
 * No hay WebSocket en esta entrega, así que el lobby hace polling sobre este endpoint
 * para mostrar la invitación como un aviso en vez de requerir compartir el join token a mano.
 */
export async function listPendingInvitations(playerId: string): Promise<Invitation[]> {
  const matches = await prisma.match.findMany({
    where: { inviteeId: playerId, status: "WAITING_FOR_OPPONENT" },
    include: { player1: true },
    orderBy: { createdAt: "desc" },
  });
  return matches.map((m) => ({
    matchId: m.id,
    joinToken: m.joinToken,
    creatorId: m.player1Id,
    creatorDisplayName: m.player1.displayName,
    rules: { startingStack: m.startingStack, smallBlind: m.smallBlind, bigBlind: m.bigBlind },
    createdAt: m.createdAt.toISOString(),
  }));
}

export interface ActiveMatchSummary {
  matchId: string;
  status: "WAITING_FOR_OPPONENT" | "IN_PROGRESS";
  /** Rival en la mesa o, si todavía no se unió, el jugador invitado. */
  opponentName: string | null;
  handNumber: number;
  yourTurn: boolean;
  updatedAt: string;
}

/** Tope de partidas listadas en el lobby: suficiente para jugar, acotado para no crecer sin límite. */
const ACTIVE_MATCHES_LIMIT = 20;

/**
 * Partidas sin terminar en las que participa el jugador (en curso o esperando rival), para que el
 * lobby permita volver a ellas sin conocer su ID. Dos consultas fijas, sin importar cuántas sean:
 * las partidas con sus jugadores, y luego los nombres de invitados y la mano actual de todas a la vez.
 */
export async function listActiveMatches(playerId: string): Promise<ActiveMatchSummary[]> {
  const matches = await prisma.match.findMany({
    where: {
      status: { in: ["WAITING_FOR_OPPONENT", "IN_PROGRESS"] },
      OR: [{ player1Id: playerId }, { player2Id: playerId }],
    },
    include: { player1: { select: { displayName: true } }, player2: { select: { displayName: true } } },
    orderBy: { updatedAt: "desc" },
    take: ACTIVE_MATCHES_LIMIT,
  });
  if (matches.length === 0) return [];

  const waitingInviteeIds = matches.filter((m) => !m.player2Id).map((m) => m.inviteeId);
  const [invitees, hands] = await Promise.all([
    waitingInviteeIds.length
      ? prisma.player.findMany({ where: { id: { in: waitingInviteeIds } }, select: { id: true, displayName: true } })
      : Promise.resolve([]),
    prisma.hand.findMany({
      where: { OR: matches.filter((m) => m.handNumber > 0).map((m) => ({ matchId: m.id, number: m.handNumber })) },
      select: { matchId: true, toActPlayerId: true },
    }),
  ]);
  const inviteeName = new Map(invitees.map((p) => [p.id, p.displayName]));
  const toActByMatch = new Map(hands.map((h) => [h.matchId, h.toActPlayerId]));

  return matches.map((m) => {
    const opponentName = !m.player2Id
      ? (inviteeName.get(m.inviteeId) ?? null)
      : m.player1Id === playerId
        ? (m.player2?.displayName ?? null)
        : m.player1.displayName;
    return {
      matchId: m.id,
      status: m.status as ActiveMatchSummary["status"],
      opponentName,
      handNumber: m.handNumber,
      yourTurn: m.status === "IN_PROGRESS" && toActByMatch.get(m.id) === playerId,
      updatedAt: m.updatedAt.toISOString(),
    };
  });
}
