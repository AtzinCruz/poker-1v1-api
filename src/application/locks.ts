import type { Match, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Serializa toda mutación de una partida (acciones, lecturas que resuelven timeouts, resign,
 * barrido de turnos vencidos) y devuelve la fila ya bloqueada. Una sola ida y vuelta: antes era
 * `SELECT id … FOR UPDATE` seguido de un `findUnique` de la misma fila.
 * Las columnas de Match son camelCase entre comillas, así que `SELECT *` llega con la misma forma
 * que el modelo de Prisma (Int → number, DateTime → Date, enum → string).
 */
export async function lockAndLoadMatch(tx: Tx, matchId: string): Promise<Match | null> {
  const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Como lockAndLoadMatch pero sin esperar: si otra transacción (una petición o el barrido de otra
 * instancia) ya tiene la partida, devuelve null y esa otra se encarga. Para trabajo de fondo,
 * donde esperar un lock ajeno solo serializa instancias sin aportar nada.
 */
export async function tryLockAndLoadMatch(tx: Tx, matchId: string): Promise<Match | null> {
  const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${matchId} FOR UPDATE SKIP LOCKED`;
  return rows[0] ?? null;
}
