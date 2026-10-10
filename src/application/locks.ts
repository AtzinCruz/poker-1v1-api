import { Prisma, type Match } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/*
 * Orden global de locks (AUD-04). Toda transacción que tome más de uno lo hace en este orden, así
 * dos transacciones nunca se esperan en círculo (deadlock → 500):
 *   1. la Idempotency-Key del comando (withIdempotency);
 *   2. las partidas: la original antes que su revancha (lockAndLoadMatchAfterParent);
 *   3. los jugadores, por id ascendente y todos de una vez (lockPlayers).
 */

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

/**
 * Partida de la que `matchId` es la revancha, si la hay. Se lee sin lock: el vínculo de una revancha
 * que sigue esperando rival no cambia (la original solo apunta a otra si esta se canceló).
 */
async function rematchParentId(tx: Tx, matchId: string): Promise<string | null> {
  const parent = await tx.match.findUnique({ where: { rematchMatchId: matchId }, select: { id: true } });
  return parent?.id ?? null;
}

/**
 * Para los caminos que pueden cancelar una revancha (y entonces avisar a la original): bloquea primero
 * la partida original y después esta, el mismo orden que usa `requestRematch`.
 */
export async function lockAndLoadMatchAfterParent(tx: Tx, matchId: string): Promise<Match | null> {
  const parentId = await rematchParentId(tx, matchId);
  if (parentId) await lockAndLoadMatch(tx, parentId);
  return lockAndLoadMatch(tx, matchId);
}

/** Versión sin espera (SKIP LOCKED) para el barrido: null si la original o esta ya las tiene otro. */
export async function tryLockAndLoadMatchAfterParent(tx: Tx, matchId: string): Promise<Match | null> {
  const parentId = await rematchParentId(tx, matchId);
  if (parentId && !(await tryLockAndLoadMatch(tx, parentId))) return null;
  return tryLockAndLoadMatch(tx, matchId);
}

/**
 * Bloquea a los jugadores por id ascendente en una sola sentencia (ORDER BY se aplica antes del lock).
 * FOR NO KEY UPDATE y no FOR UPDATE: basta para serializar cambios de saldo y no frena los INSERT que
 * solo referencian al jugador por clave foránea (acciones, claves de idempotencia).
 */
export async function lockPlayers(tx: Tx, playerIds: string[]): Promise<void> {
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "Player" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR NO KEY UPDATE`;
}
