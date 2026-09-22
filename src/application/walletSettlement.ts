import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Libera la reserva de saldo (blockedBalance) hecha al crear/unirse a la partida y devuelve
 * el stack final de esa partida a la billetera ficticia del jugador. Se llama exactamente una
 * vez por jugador cuando la partida termina (MATCH_FINISHED), sin importar el motivo.
 */
export async function refundReservedStack(
  tx: Tx,
  params: { playerId: string; reservedAmount: number; finalStack: number },
): Promise<void> {
  const player = await tx.player.findUniqueOrThrow({ where: { id: params.playerId } });
  await tx.player.update({
    where: { id: params.playerId },
    data: {
      blockedBalance: Math.max(0, player.blockedBalance - params.reservedAmount),
      fictionalBalance: player.fictionalBalance + params.finalStack,
    },
  });
}
