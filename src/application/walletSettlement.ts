import type { Match, Prisma } from "@prisma/client";
import { DomainError } from "../domain/errors.js";
import { lockPlayers } from "./locks.js";

type Tx = Prisma.TransactionClient;

/*
 * Todos los cambios de saldo son incrementos atómicos en una sola sentencia, nunca "leer y escribir
 * el valor calculado" (AUD-01): la liquidación leía al jugador sin lock y escribía un saldo absoluto,
 * así que una reserva, otra liquidación o un abono de admin concurrentes se perdían (fichas creadas
 * y destruidas). La BD además rechaza saldos negativos (CHECK, AUD-18): un desajuste falla en vez de
 * esconderse.
 */

/**
 * Pasa `amount` del saldo disponible al bloqueado (la entrada a una partida). La condición y el
 * descuento van en la misma sentencia: dos reservas simultáneas no pueden gastar el mismo saldo.
 */
export async function reserveStack(tx: Tx, playerId: string, amount: number): Promise<void> {
  const reserved = await tx.player.updateMany({
    where: { id: playerId, fictionalBalance: { gte: amount } },
    data: { fictionalBalance: { decrement: amount }, blockedBalance: { increment: amount } },
  });
  if (reserved.count === 0) {
    throw new DomainError("INSUFFICIENT_STACK", "Saldo ficticio insuficiente para esta entrada");
  }
}

/**
 * Libera la reserva (blockedBalance) hecha al crear/unirse a la partida y devuelve el stack final de
 * esa partida a la billetera ficticia del jugador. Se llama exactamente una vez por jugador cuando la
 * partida termina o se cancela, sin importar el motivo.
 */
export async function refundReservedStack(
  tx: Tx,
  params: { playerId: string; reservedAmount: number; finalStack: number },
): Promise<void> {
  await tx.player.update({
    where: { id: params.playerId },
    data: {
      blockedBalance: { decrement: params.reservedAmount },
      fictionalBalance: { increment: params.finalStack },
    },
  });
}

/**
 * Liquida una partida terminada para sus dos jugadores. Los bloquea primero, por id y de una vez
 * (lockPlayers): antes se actualizaban en orden de asiento y dos partidas con los asientos cruzados
 * entre los mismos jugadores se bloqueaban mutuamente (AUD-04).
 */
export async function settleFinishedMatch(
  tx: Tx,
  match: Pick<Match, "player1Id" | "player2Id" | "startingStack">,
  finalStacks: { player1: number; player2: number },
): Promise<void> {
  const player2Id = match.player2Id;
  if (!player2Id) throw new Error("Una partida sin segundo jugador no se liquida: se cancela");
  await lockPlayers(tx, [match.player1Id, player2Id]);
  await refundReservedStack(tx, { playerId: match.player1Id, reservedAmount: match.startingStack, finalStack: finalStacks.player1 });
  await refundReservedStack(tx, { playerId: player2Id, reservedAmount: match.startingStack, finalStack: finalStacks.player2 });
}
