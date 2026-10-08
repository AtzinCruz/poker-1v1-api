import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "../infrastructure/prisma/client.js";
import { signAdminToken } from "../infrastructure/auth/jwt.js";
import { hashPassword } from "../infrastructure/auth/password.js";
import { forgetTokenVersion } from "../infrastructure/auth/tokenVersionCache.js";
import { config } from "../config.js";
import { DomainError } from "../domain/errors.js";

/** Comparación en tiempo constante (sobre digests, para no filtrar la longitud de la clave). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Login de administrador: requiere conocer ADMIN_SECRET (variable de entorno del servidor). */
export function createAdminSession(name: string, secret: string): { token: string; name: string } {
  if (!config.adminSecret) {
    throw new DomainError("UNAUTHENTICATED", "El panel de administración no está habilitado en este servidor");
  }
  if (!safeEqual(secret, config.adminSecret)) {
    throw new DomainError("UNAUTHENTICATED", "Clave de administrador incorrecta");
  }
  return { token: signAdminToken(name), name };
}

export interface AdminPlayerRow {
  id: string;
  displayName: string;
  hasPassword: boolean;
  fictionalBalance: number;
  blockedBalance: number;
  createdAt: string;
}

export async function listAllPlayers(): Promise<AdminPlayerRow[]> {
  const players = await prisma.player.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return players.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    hasPassword: p.passwordHash !== null,
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

/** Tope para no desbordar la columna Int (32 bits) de Postgres con ajustes repetidos. */
export const MAX_FICTIONAL_BALANCE = 2_000_000_000;

/** Acredita `amount` fichas ficticias al saldo disponible de un jugador y deja registro de auditoría. */
export async function addPlayerBalance(playerId: string, amount: number, adminName: string): Promise<AdminPlayerRow> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("INVALID_ACTION", "El monto a agregar debe ser un entero positivo");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${playerId} FOR UPDATE`;
    const player = await tx.player.findUnique({ where: { id: playerId } });
    if (!player) {
      throw new DomainError("INVALID_ACTION", "El jugador no existe");
    }
    const balanceAfter = player.fictionalBalance + amount;
    if (balanceAfter > MAX_FICTIONAL_BALANCE) {
      throw new DomainError("INVALID_ACTION", `El saldo no puede superar ${MAX_FICTIONAL_BALANCE} fichas`);
    }
    const updated = await tx.player.update({
      where: { id: playerId },
      data: { fictionalBalance: balanceAfter },
    });
    await tx.adminAction.create({
      data: {
        adminName,
        type: "ADD_BALANCE",
        playerId,
        amount,
        balanceBefore: player.fictionalBalance,
        balanceAfter,
      },
    });
    return {
      id: updated.id,
      displayName: updated.displayName,
      hasPassword: updated.passwordHash !== null,
      fictionalBalance: updated.fictionalBalance,
      blockedBalance: updated.blockedBalance,
      createdAt: updated.createdAt.toISOString(),
    };
  });
}

/**
 * Contraseña temporal legible (sin 0/O/1/l/I), ~69 bits de entropía. `randomInt` es uniforme; con
 * `byte % 31` los primeros 8 caracteres del alfabeto salían más seguido (256 no es múltiplo de 31).
 */
export function generateTemporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}

/**
 * Asigna una contraseña temporal a una cuenta (olvidó la suya, o es anterior a las contraseñas) y revoca
 * todas sus sesiones. La contraseña se devuelve UNA sola vez, al admin, para que se la haga llegar a la
 * persona; no se guarda en claro. La cuenta nunca queda "abierta" para que la reclame cualquiera.
 */
export async function resetPlayerPassword(
  playerId: string,
  adminName: string,
): Promise<AdminPlayerRow & { temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${playerId} FOR UPDATE`;
    const player = await tx.player.findUnique({ where: { id: playerId } });
    if (!player) {
      throw new DomainError("INVALID_ACTION", "El jugador no existe");
    }
    const updated = await tx.player.update({
      where: { id: playerId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    await tx.adminAction.create({
      data: {
        adminName,
        type: "RESET_PASSWORD",
        playerId,
        amount: 0,
        balanceBefore: player.fictionalBalance,
        balanceAfter: player.fictionalBalance,
      },
    });
    return {
      id: updated.id,
      displayName: updated.displayName,
      hasPassword: true,
      fictionalBalance: updated.fictionalBalance,
      blockedBalance: updated.blockedBalance,
      createdAt: updated.createdAt.toISOString(),
      temporaryPassword,
    };
  });
  // Después del COMMIT: invalidar antes dejaría que una petición concurrente volviera a cachear la versión vieja.
  forgetTokenVersion(playerId);
  return result;
}
