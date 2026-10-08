import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Serializa toda mutación de una partida (acciones, lecturas que resuelven timeouts, resign,
 * barrido de turnos vencidos). Debe llamarse ANTES de leer el estado que se va a modificar.
 */
export async function lockMatch(tx: Tx, matchId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
}

/**
 * Como lockMatch pero sin esperar: si otra transacción (una petición o el barrido de otra
 * instancia) ya tiene la partida, devuelve false y esa otra se encarga. Para trabajo de fondo,
 * donde esperar un lock ajeno solo serializa instancias sin aportar nada.
 */
export async function tryLockMatch(tx: Tx, matchId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE SKIP LOCKED`;
  return rows.length > 0;
}
