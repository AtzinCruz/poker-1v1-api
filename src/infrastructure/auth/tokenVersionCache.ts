import { prisma } from "../prisma/client.js";

/**
 * Caché corta de Player.tokenVersion. Sin ella, cada petición autenticada hacía una consulta solo
 * para detectar revocaciones, que pasan rarísima vez: 1 de las 6 idas y vueltas del GET de partida.
 *
 * Trade-off: en OTRA instancia, un token revocado puede seguir valiendo hasta TTL_MS. En la
 * instancia que procesa el cambio de contraseña la revocación es inmediata (forgetTokenVersion).
 */
const TTL_MS = 5_000;
const MAX_ENTRIES = 50_000;
const cache = new Map<string, { version: number; expiresAt: number }>();

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
  // Tope de memoria simple: vaciar es barato y la caché se rellena sola en TTL_MS.
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(playerId, { version: player.tokenVersion, expiresAt: now + TTL_MS });
  return player.tokenVersion;
}

/** Llamar tras subir tokenVersion (cambio o restablecimiento de contraseña). */
export function forgetTokenVersion(playerId: string): void {
  cache.delete(playerId);
}
