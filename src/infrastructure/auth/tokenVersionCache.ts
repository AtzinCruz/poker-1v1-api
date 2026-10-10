import { prisma } from "../prisma/client.js";

/**
 * Caché corta de Player.tokenVersion. Sin ella, cada petición autenticada hacía una consulta solo
 * para detectar revocaciones, que pasan rarísima vez: 1 de las 6 idas y vueltas del GET de partida.
 *
 * Trade-off: en OTRA instancia, un token revocado puede seguir valiendo hasta TTL_MS. En la
 * instancia que procesa el cambio de contraseña la revocación es inmediata (rememberTokenVersion).
 */
const TTL_MS = 5_000;
const MAX_ENTRIES = 50_000;
const cache = new Map<string, { version: number; expiresAt: number }>();

/**
 * tokenVersion solo sube: nunca se guarda una versión menor que la ya conocida. Así una lectura
 * concurrente que leyó la versión vieja antes del cambio no puede volver a cachearla después (AUD-14).
 */
function store(playerId: string, version: number, now: number): number {
  const known = cache.get(playerId);
  const effective = known && known.version > version ? known.version : version;
  // Tope de memoria simple: vaciar es barato y la caché se rellena sola en TTL_MS.
  if (cache.size >= MAX_ENTRIES && !known) cache.clear();
  cache.set(playerId, { version: effective, expiresAt: now + TTL_MS });
  return effective;
}

/** Versión vigente de los tokens del jugador, o null si el jugador no existe. */
export async function currentTokenVersion(playerId: string): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(playerId);
  if (cached && cached.expiresAt > now) return cached.version;

  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { tokenVersion: true } });
  if (!player) {
    cache.delete(playerId);
    return null;
  }
  return store(playerId, player.tokenVersion, now);
}

/** Llamar tras subir tokenVersion (cambio o restablecimiento de contraseña), con la versión nueva ya confirmada. */
export function rememberTokenVersion(playerId: string, version: number): void {
  store(playerId, version, Date.now());
}
