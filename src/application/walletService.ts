import { prisma } from "../infrastructure/prisma/client.js";
import { DomainError } from "../domain/errors.js";

export interface WalletView {
  playerId: string;
  available: number;
  blocked: number;
}

export async function getWallet(playerId: string): Promise<WalletView> {
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) {
    throw new DomainError("UNAUTHENTICATED", "Jugador no encontrado");
  }
  return { playerId: player.id, available: player.fictionalBalance, blocked: player.blockedBalance };
}
