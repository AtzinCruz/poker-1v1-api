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

/**
 * Inicia sesión o crea la cuenta:
 *  - nombre nuevo → se crea con esa contraseña;
 *  - nombre con contraseña → se verifica;
 *  - nombre anterior a las contraseñas (sin hash) → quien entra primero fija la suya
 *    (si la dueña/o no pudiera, un admin la restablece desde el panel).
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
  } else if (player.passwordHash) {
    if (!(await verifyPassword(password, player.passwordHash))) throw BAD_CREDENTIALS();
  } else {
    // Reclamo atómico: si dos personas entran a la vez, solo una fija la contraseña.
    const passwordHash = await hashPassword(password);
    const claimed = await prisma.player.updateMany({
      where: { id: player.id, passwordHash: null },
      data: { passwordHash },
    });
    if (claimed.count !== 1) {
      const current = await prisma.player.findUniqueOrThrow({ where: { id: player.id } });
      if (!current.passwordHash || !(await verifyPassword(password, current.passwordHash))) throw BAD_CREDENTIALS();
      player = current;
    }
  }

  const token = signPlayerToken({ sub: player.id, displayName: player.displayName });
  return {
    token,
    player: { id: player.id, displayName: player.displayName, fictionalBalance: player.fictionalBalance },
  };
}
