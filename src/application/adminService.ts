import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "../infrastructure/prisma/client.js";
import { runTransaction } from "../infrastructure/prisma/transaction.js";
import { withIdempotency } from "../infrastructure/idempotency.js";
import { signAdminToken, type AdminTokenPayload } from "../infrastructure/auth/jwt.js";
import { hashPassword } from "../infrastructure/auth/password.js";
import { rememberTokenVersion } from "../infrastructure/auth/tokenVersionCache.js";
import { config } from "../config.js";
import { DomainError } from "../domain/errors.js";
import { lockPlayers } from "./locks.js";

/** Comparación en tiempo constante (sobre digests, para no filtrar la longitud de la clave). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * Login de administrador (AUD-20):
 *  - con una cuenta de ADMIN_ACCOUNTS, nombre y clave tienen que corresponderse: el nombre que queda
 *    en AdminAction está autenticado;
 *  - con la clave compartida ADMIN_SECRET el nombre lo declara quien entra (modo heredado); en el
 *    registro de auditoría queda marcado como tal.
 * Se comparan todas las claves siempre, para que el tiempo de respuesta no delate qué nombres existen.
 */
export function createAdminSession(name: string, secret: string): { token: string; name: string } {
  if (!config.adminSecret && config.adminAccounts.length === 0) {
    throw new DomainError("UNAUTHENTICATED", "El panel de administración no está habilitado en este servidor");
  }
  let payload: AdminTokenPayload | null = null;
  for (const account of config.adminAccounts) {
    const matches = safeEqual(secret, account.secret);
    if (matches && account.name === name && !payload) payload = { name: account.name, shared: false };
  }
  if (!payload && config.adminSecret && safeEqual(secret, config.adminSecret)) {
    payload = { name, shared: true };
  }
  if (!payload) {
    throw new DomainError("UNAUTHENTICATED", "Nombre o clave de administrador incorrectos");
  }
  return { token: signAdminToken(payload), name };
}

/** Nombre que queda en AdminAction: el de una cuenta propia, o el declarado marcado como no verificado. */
export function auditName(admin: AdminTokenPayload): string {
  return admin.shared ? `${admin.name} (clave compartida)` : admin.name;
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

/**
 * Acredita `amount` fichas ficticias al saldo disponible de un jugador y deja registro de auditoría.
 * Incremento atómico con el tope en la misma sentencia (AUD-01) e idempotente: un doble clic con la
 * misma Idempotency-Key acredita una sola vez (AUD-20). La clave se guarda a nombre del jugador
 * acreditado; el scope incluye al admin, así que otro admin con la misma clave recibe 409.
 */
export async function addPlayerBalance(
  playerId: string,
  amount: number,
  adminName: string,
  idempotencyKey: string,
): Promise<AdminPlayerRow> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("INVALID_ACTION", "El monto a agregar debe ser un entero positivo");
  }
  const exists = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true } });
  if (!exists) {
    throw new DomainError("INVALID_ACTION", "El jugador no existe");
  }
  const result = await runTransaction((tx) =>
    withIdempotency(
      tx,
      { playerId, key: idempotencyKey, scope: `admin-add-balance:${adminName}`, requestBody: { amount } },
      async () => {
        await lockPlayers(tx, [playerId]);
        const credited = await tx.player.updateMany({
          where: { id: playerId, fictionalBalance: { lte: MAX_FICTIONAL_BALANCE - amount } },
          data: { fictionalBalance: { increment: amount } },
        });
        if (credited.count === 0) {
          throw new DomainError("INVALID_ACTION", `El saldo no puede superar ${MAX_FICTIONAL_BALANCE} fichas`);
        }
        const updated = await tx.player.findUniqueOrThrow({ where: { id: playerId } });
        await tx.adminAction.create({
          data: {
            adminName,
            type: "ADD_BALANCE",
            playerId,
            amount,
            balanceBefore: updated.fictionalBalance - amount,
            balanceAfter: updated.fictionalBalance,
          },
        });
        const row: AdminPlayerRow = {
          id: updated.id,
          displayName: updated.displayName,
          hasPassword: updated.passwordHash !== null,
          fictionalBalance: updated.fictionalBalance,
          blockedBalance: updated.blockedBalance,
          createdAt: updated.createdAt.toISOString(),
        };
        return { status: 200, body: row };
      },
    ),
  );
  return result.body;
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
  const result = await runTransaction(async (tx) => {
    await lockPlayers(tx, [playerId]);
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
      row: {
        id: updated.id,
        displayName: updated.displayName,
        hasPassword: true,
        fictionalBalance: updated.fictionalBalance,
        blockedBalance: updated.blockedBalance,
        createdAt: updated.createdAt.toISOString(),
        temporaryPassword,
      },
      tokenVersion: updated.tokenVersion,
    };
  });
  // Después del COMMIT: la caché nunca baja de versión, así que una lectura concurrente no revive la vieja.
  rememberTokenVersion(playerId, result.tokenVersion);
  return result.row;
}
