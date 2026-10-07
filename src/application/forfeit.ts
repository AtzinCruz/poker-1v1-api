import type { Match, Prisma } from "@prisma/client";
import { logEvent } from "./events.js";
import { getMatchStack, otherSlot, slotOfPlayer } from "./seats.js";
import { refundReservedStack } from "./walletSettlement.js";

type Tx = Prisma.TransactionClient;

/**
 * Termina una partida en curso por abandono o desconexión de `loserId` (secciones 6 y 9 del spec:
 * "el rival gana el saldo en juego"). Debe llamarse con la fila de Match ya bloqueada.
 *
 * - Cierra la mano activa (sin esto la mano quedaba con turno vigente y un timeout posterior
 *   podía resucitar la partida).
 * - El ganador recibe TODO el saldo en juego: su stack, el stack del rival y el pozo de la mano.
 *   Las fichas nunca se destruyen: stack1 + stack2 + pozo se conserva.
 * - Libera la reserva y acredita el stack final de cada jugador a su billetera.
 */
export async function finishMatchByForfeit(
  tx: Tx,
  match: Match,
  loserId: string,
  reason: "RESIGN" | "DISCONNECT_TIMEOUT",
): Promise<Match> {
  const loserSlot = slotOfPlayer(match, loserId);
  const winnerSlot = otherSlot(loserSlot);
  const winnerId = winnerSlot === "player1" ? match.player1Id : match.player2Id!;

  const hand =
    match.handNumber > 0
      ? await tx.hand.findUnique({ where: { matchId_number: { matchId: match.id, number: match.handNumber } } })
      : null;
  const activeHand = hand && hand.phase !== "HAND_FINISHED" ? hand : null;
  const pot = activeHand ? activeHand.player1Contribution + activeHand.player2Contribution : 0;

  const totalInPlay = getMatchStack(match, "player1") + getMatchStack(match, "player2") + pot;
  const finalStacks = {
    player1: winnerSlot === "player1" ? totalInPlay : 0,
    player2: winnerSlot === "player2" ? totalInPlay : 0,
  };

  if (activeHand) {
    await tx.hand.update({
      where: { id: activeHand.id },
      data: {
        phase: "HAND_FINISHED",
        winnerId,
        winReason: "FORFEIT",
        payoutPlayer1: winnerSlot === "player1" ? pot : 0,
        payoutPlayer2: winnerSlot === "player2" ? pot : 0,
        deckSeedRevealedAt: new Date(),
        toActPlayerId: null,
        turnExpiresAt: null,
      },
    });
  }

  const updated = await tx.match.update({
    where: { id: match.id },
    data: {
      status: "MATCH_FINISHED",
      finishReason: reason,
      winnerId,
      player1Stack: finalStacks.player1,
      player2Stack: finalStacks.player2,
      stateVersion: { increment: 1 },
    },
  });

  await refundReservedStack(tx, {
    playerId: updated.player1Id,
    reservedAmount: updated.startingStack,
    finalStack: finalStacks.player1,
  });
  await refundReservedStack(tx, {
    playerId: updated.player2Id!,
    reservedAmount: updated.startingStack,
    finalStack: finalStacks.player2,
  });

  await logEvent(tx, {
    matchId: updated.id,
    type: "match.finished",
    stateVersion: updated.stateVersion,
    publicPayload: { reason, winnerId, finalStacks },
  });

  return updated;
}
