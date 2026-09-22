import { prisma } from "../infrastructure/prisma/client.js";
import { signPlayerToken } from "../infrastructure/auth/jwt.js";

export interface DevSessionResult {
  token: string;
  player: { id: string; displayName: string; fictionalBalance: number };
}

/**
 * Stub del "módulo de identidad" (fuera de alcance del spec): crea el jugador si no existe
 * y emite un JWT. En una integración real esto lo haría un IdP externo, no esta API.
 */
export async function createDevSession(displayName: string): Promise<DevSessionResult> {
  const player = await prisma.player.upsert({
    where: { displayName },
    update: {},
    create: { displayName },
  });

  const token = signPlayerToken({ sub: player.id, displayName: player.displayName });
  return {
    token,
    player: { id: player.id, displayName: player.displayName, fictionalBalance: player.fictionalBalance },
  };
}
