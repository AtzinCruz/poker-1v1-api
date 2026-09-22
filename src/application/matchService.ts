import { randomBytes } from "node:crypto";
import type { Match } from "@prisma/client";
import { prisma } from "../infrastructure/prisma/client.js";
import { withIdempotency } from "../infrastructure/idempotency.js";
import { DomainError } from "../domain/errors.js";
import { dealNewHand } from "./dealing.js";
import { resolveExpiredTurns } from "./timeouts.js";
import { logEvent } from "./events.js";
import { refundReservedStack } from "./walletSettlement.js";

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
      { playerId: input.creatorId, key: input.idempotencyKey, requestBody: input.body },
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
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: input.matchId } });
    if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe");

    const result = await withIdempotency(
      tx,
      { playerId: input.playerId, key: input.idempotencyKey, requestBody: input.body },
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
  await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: input.matchId } });
    if (!match) return;
    if (match.player1Id !== input.playerId && match.player2Id !== input.playerId) return;
    const hand = match.handNumber > 0
      ? await tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber } } })
      : null;
    await resolveExpiredTurns(tx, match, hand);
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: input.matchId } });
    if (!match) throw new DomainError("MATCH_NOT_FOUND", "La partida no existe");

    const result = await withIdempotency(
      tx,
      { playerId: input.playerId, key: input.idempotencyKey, requestBody: {} },
      async () => {
        if (match.player1Id !== input.playerId && match.player2Id !== input.playerId) {
          throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
        }
        if (match.status === "MATCH_FINISHED" || match.status === "CANCELLED") {
          return { status: 200, body: toMatchResource(match, false) };
        }

        let updated: Match;
        if (match.status === "WAITING_FOR_OPPONENT") {
          updated = await tx.match.update({
            where: { id: match.id },
            data: { status: "CANCELLED", stateVersion: { increment: 1 } },
          });
          await refundReservedStack(tx, {
            playerId: updated.player1Id,
            reservedAmount: updated.startingStack,
            finalStack: updated.startingStack,
          });
        } else {
          const winnerId = match.player1Id === input.playerId ? match.player2Id! : match.player1Id;
          updated = await tx.match.update({
            where: { id: match.id },
            data: {
              status: "MATCH_FINISHED",
              finishReason: "RESIGN",
              winnerId,
              stateVersion: { increment: 1 },
            },
          });
          await refundReservedStack(tx, {
            playerId: updated.player1Id,
            reservedAmount: updated.startingStack,
            finalStack: updated.player1Stack ?? updated.startingStack,
          });
          await refundReservedStack(tx, {
            playerId: updated.player2Id!,
            reservedAmount: updated.startingStack,
            finalStack: updated.player2Stack ?? updated.startingStack,
          });
        }

        await logEvent(tx, {
          matchId: updated.id,
          type: "match.finished",
          stateVersion: updated.stateVersion,
          publicPayload: { reason: updated.finishReason ?? "CANCELLED", winnerId: updated.winnerId },
        });

        return { status: 200, body: toMatchResource(updated, false) };
      },
    );

    return { ...result };
  });
}
