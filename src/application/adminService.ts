import { prisma } from "../infrastructure/prisma/client.js";
import { signAdminToken } from "../infrastructure/auth/jwt.js";
import { config } from "../config.js";
import { DomainError } from "../domain/errors.js";

/** Login de administrador: requiere conocer ADMIN_SECRET (variable de entorno del servidor). */
export function createAdminSession(name: string, secret: string): { token: string; name: string } {
  if (!config.adminSecret) {
    throw new DomainError("UNAUTHENTICATED", "El panel de administración no está habilitado en este servidor");
  }
  if (secret !== config.adminSecret) {
    throw new DomainError("UNAUTHENTICATED", "Clave de administrador incorrecta");
  }
  return { token: signAdminToken(name), name };
}

export interface AdminPlayerRow {
  id: string;
  displayName: string;
  fictionalBalance: number;
  blockedBalance: number;
  createdAt: string;
}

export async function listAllPlayers(): Promise<AdminPlayerRow[]> {
  const players = await prisma.player.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return players.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    fictionalBalance: p.fictionalBalance,
    blockedBalance: p.blockedBalance,
    createdAt: p.createdAt.toISOString(),
  }));
}

export interface AdminMatchRow {
  id: string;
  status: string;
  player1DisplayName: string;
  player2DisplayName: string | null;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  finishReason: string | null;
  winnerDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAllMatches(): Promise<AdminMatchRow[]> {
  const matches = await prisma.match.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { player1: true, player2: true },
  });
  return matches.map((m) => ({
    id: m.id,
    status: m.status,
    player1DisplayName: m.player1.displayName,
    player2DisplayName: m.player2?.displayName ?? null,
    startingStack: m.startingStack,
    smallBlind: m.smallBlind,
    bigBlind: m.bigBlind,
    handNumber: m.handNumber,
    finishReason: m.finishReason,
    winnerDisplayName:
      m.winnerId === m.player1Id ? m.player1.displayName : m.winnerId === m.player2Id ? (m.player2?.displayName ?? null) : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));
}

/** Acredita `amount` fichas ficticias al saldo disponible de un jugador. Solo para el panel de admin. */
export async function addPlayerBalance(playerId: string, amount: number): Promise<AdminPlayerRow> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("INVALID_ACTION", "El monto a agregar debe ser un entero positivo");
  }
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) {
    throw new DomainError("INVALID_ACTION", "El jugador no existe");
  }
  const updated = await prisma.player.update({
    where: { id: playerId },
    data: { fictionalBalance: player.fictionalBalance + amount },
  });
  return {
    id: updated.id,
    displayName: updated.displayName,
    fictionalBalance: updated.fictionalBalance,
    blockedBalance: updated.blockedBalance,
    createdAt: updated.createdAt.toISOString(),
  };
}
