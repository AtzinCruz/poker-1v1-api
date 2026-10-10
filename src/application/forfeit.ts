import type { Match, Prisma } from "@prisma/client";
import { logEvent } from "./events.js";
import { finishMatch } from "./matchEnd.js";
import { getMatchStack, otherSlot, slotOfPlayer } from "./seats.js";
import { notifyMatchChanged } from "../infrastructure/matchNotifier.js";

type Tx = Prisma.TransactionClient;

/**
 * Termina una partida en curso por abandono o desconexión de `loserId`. Debe llamarse con la fila de
 * Match ya bloqueada.
 *
 * - Quien se va conserva su stack: pierde la partida y lo que ya puso en la mano en curso (como si se
 *   retirara), no todas sus fichas. Decisión de producto que reemplaza la regla del spec (§6/§9: "el
 *   rival gana el saldo en juego de la sesión"); vale igual para el abandono y para la desconexión.
 * - El rival recibe el pozo de la mano en curso, además de su propio stack.
 * - Cierra la mano activa (sin esto la mano quedaba con turno vigente y un timeout posterior
 *   podía resucitar la partida). Las fichas nunca se destruyen: stack1 + stack2 + pozo se conserva.
 * - Libera la reserva y acredita el stack final de cada jugador a su billetera (finishMatch).
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

  const finalStacks = {
    player1: getMatchStack(match, "player1") + (winnerSlot === "player1" ? pot : 0),
    player2: getMatchStack(match, "player2") + (winnerSlot === "player2" ? pot : 0),
  };

  if (activeHand) {
    const payout = { player1: winnerSlot === "player1" ? pot : 0, player2: winnerSlot === "player2" ? pot : 0 };
    await tx.hand.update({
      where: { id: activeHand.id },
      data: {
        phase: "HAND_FINISHED",
        winnerId,
        winReason: "FORFEIT",
        payoutPlayer1: payout.player1,
        payoutPlayer2: payout.player2,
        toActPlayerId: null,
        turnExpiresAt: null,
      },
    });
    await logEvent(tx, {
      matchId: match.id,
      handId: activeHand.id,
      type: "hand.finished",
      stateVersion: match.stateVersion,
      publicPayload: { winnerId, reason: "FORFEIT", payout, revealedCards: null },
    });
  }

  const updated = await finishMatch(tx, match, { reason, winnerId, finalStacks });
  await notifyMatchChanged(tx, updated.id);
  return updated;
}
