import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Serializa toda mutación de una partida (acciones, lecturas que resuelven timeouts, resign,
 * barrido de turnos vencidos). Debe llamarse ANTES de leer el estado que se va a modificar.
 */
export async function lockMatch(tx: Tx, matchId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
}
