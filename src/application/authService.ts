import { prisma } from "../infrastructure/prisma/client.js";
import { signPlayerToken } from "../infrastructure/auth/jwt.js";
import { hashPassword, verifyPassword } from "../infrastructure/auth/password.js";
import { DomainError } from "../domain/errors.js";

export interface SessionResult {
  token: string;
  player: { id: string; displayName: string; fictionalBalance: number };
}

/** Mismo mensaje para "no existe" y "contraseña incorrecta": no revela qué nombres están registrados. */
const BAD_CREDENTIALS = () => new DomainError("UNAUTHENTICATED", "Nombre o contraseña incorrectos");

function toSession(player: { id: string; displayName: string; fictionalBalance: number; tokenVersion: number }): SessionResult {
  const token = signPlayerToken({ sub: player.id, displayName: player.displayName, tv: player.tokenVersion });
  return {
    token,
    player: { id: player.id, displayName: player.displayName, fictionalBalance: player.fictionalBalance },
  };
}

/**
 * Inicia sesión o crea la cuenta:
 *  - nombre nuevo → se crea con esa contraseña;
 *  - nombre con contraseña → se verifica;
 *  - nombre anterior a las contraseñas (sin hash) → NO se puede reclamar entrando: un admin tiene que
 *    asignarle una contraseña temporal (así nadie se adelanta a la dueña/o de la cuenta).
 * No hay verificación de identidad más allá de la contraseña: no es un IdP real.
 */
export async function loginOrRegister(displayName: string, password: string): Promise<SessionResult> {
  let player = await prisma.player.findUnique({ where: { displayName } });

  if (!player) {
    const passwordHash = await hashPassword(password);
    try {
      player = await prisma.player.create({ data: { displayName, passwordHash } });
    } catch (error) {
      // Carrera: otra solicitud creó el mismo nombre un instante antes → se trata como cuenta existente.
      if ((error as { code?: string }).code !== "P2002") throw error;
      player = await prisma.player.findUnique({ where: { displayName } });
      if (!player?.passwordHash || !(await verifyPassword(password, player.passwordHash))) throw BAD_CREDENTIALS();
    }
  } else if (!player.passwordHash) {
    // Cuenta sin contraseña: se calcula un hash igual para que el tiempo de respuesta no la delate.
    await hashPassword(password);
    throw BAD_CREDENTIALS();
  } else if (!(await verifyPassword(password, player.passwordHash))) {
    throw BAD_CREDENTIALS();
  }

  return toSession(player);
}

/**
 * Cambio de contraseña por la propia persona. Sube `tokenVersion`: todos los tokens emitidos antes
 * (incluido uno robado) dejan de valer; se devuelve una sesión nueva para quien cambió.
 */
export async function changePassword(playerId: string, currentPassword: string, newPassword: string): Promise<SessionResult> {
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player?.passwordHash || !(await verifyPassword(currentPassword, player.passwordHash))) {
    throw new DomainError("UNAUTHENTICATED", "La contraseña actual no es correcta");
  }
  const passwordHash = await hashPassword(newPassword);
  const updated = await prisma.player.update({
    where: { id: playerId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  return toSession(updated);
}
