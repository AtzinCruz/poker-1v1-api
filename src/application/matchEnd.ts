import type { FinishReason, Match, Prisma } from "@prisma/client";
import { logEvent } from "./events.js";
import { settleFinishedMatch } from "./walletSettlement.js";

type Tx = Prisma.TransactionClient;

/**
 * Las semillas de TODAS las manos se publican al terminar la partida, no al terminar cada mano
 * (AUD-03). Con la semilla y los descartes se rearman las dos manos finales, también la que se
 * retiró sin mostrarse (muck): publicarla mano a mano dejaba perfilar al rival durante la sesión.
 * El compromiso (`deckCommitment`) sí se publica desde el reparto (AUD-07), así que cada mano sigue
 * siendo verificable: sha256(deckSeed) === deckCommitment.
 */
export async function revealMatchSeeds(tx: Tx, matchId: string): Promise<void> {
  await tx.hand.updateMany({ where: { matchId, deckSeedRevealedAt: null }, data: { deckSeedRevealedAt: new Date() } });
}

/**
 * Cierra una partida en curso (MATCH_FINISHED) con su resultado: libera las reservas y acredita los
 * stacks finales (bloqueando a los jugadores en el orden global), revela las semillas y deja el
 * evento §7 `match.finished`. Debe llamarse con la fila de Match ya bloqueada.
 */
export async function finishMatch(
  tx: Tx,
  match: Match,
  result: { reason: FinishReason; winnerId: string; finalStacks: { player1: number; player2: number } },
): Promise<Match> {
  const updated = await tx.match.update({
    where: { id: match.id },
    data: {
      status: "MATCH_FINISHED",
      finishReason: result.reason,
      winnerId: result.winnerId,
      player1Stack: result.finalStacks.player1,
      player2Stack: result.finalStacks.player2,
      stateVersion: { increment: 1 },
    },
  });
  await settleFinishedMatch(tx, updated, result.finalStacks);
  await revealMatchSeeds(tx, updated.id);
  await logEvent(tx, {
    matchId: updated.id,
    type: "match.finished",
    stateVersion: updated.stateVersion,
    publicPayload: { reason: result.reason, winnerId: result.winnerId, finalStacks: result.finalStacks },
  });
  return updated;
}
