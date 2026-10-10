import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { currentTokenVersion } from "../infrastructure/auth/tokenVersionCache.js";
import { verifyAdminToken, verifyPlayerToken, type AdminTokenPayload, type AuthTokenPayload } from "../infrastructure/auth/jwt.js";

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new DomainError("UNAUTHENTICATED", "Falta el encabezado Authorization: Bearer <jwt>");
  }
  return header.slice("Bearer ".length);
}

/** Verifica la firma y que el token siga vigente: cambiar/restablecer la contraseña revoca los anteriores. */
export async function requireAuthenticatedSession(request: FastifyRequest): Promise<AuthTokenPayload> {
  let payload;
  try {
    payload = verifyPlayerToken(bearerToken(request));
  } catch {
    throw new DomainError("UNAUTHENTICATED", "JWT inválido o vencido");
  }
  if ((await currentTokenVersion(payload.sub)) !== payload.tv) {
    throw new DomainError("UNAUTHENTICATED", "La sesión ya no es válida; vuelve a entrar");
  }
  return payload;
}

export async function requireAuthenticatedPlayer(request: FastifyRequest): Promise<string> {
  return (await requireAuthenticatedSession(request)).sub;
}

/**
 * Jugador del token SOLO para elegir la clave de un límite de tasa: verifica la firma (sin ir a la BD)
 * y no lanza. La autorización de verdad la hace cada ruta con requireAuthenticatedPlayer.
 */
export function playerIdForRateLimit(request: FastifyRequest): string | null {
  try {
    return verifyPlayerToken(bearerToken(request)).sub;
  } catch {
    return null;
  }
}

export function requireAdmin(request: FastifyRequest): AdminTokenPayload {
  try {
    return verifyAdminToken(bearerToken(request));
  } catch {
    throw new DomainError("UNAUTHENTICATED", "Token de administrador inválido, vencido o ausente");
  }
}
