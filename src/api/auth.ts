import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { currentTokenVersion } from "../infrastructure/auth/tokenVersionCache.js";
import { verifyAdminToken, verifyPlayerToken } from "../infrastructure/auth/jwt.js";

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new DomainError("UNAUTHENTICATED", "Falta el encabezado Authorization: Bearer <jwt>");
  }
  return header.slice("Bearer ".length);
}

/** Verifica la firma y que el token siga vigente: cambiar/restablecer la contraseña revoca los anteriores. */
export async function requireAuthenticatedPlayer(request: FastifyRequest): Promise<string> {
  let payload;
  try {
    payload = verifyPlayerToken(bearerToken(request));
  } catch {
    throw new DomainError("UNAUTHENTICATED", "JWT inválido o vencido");
  }
  if ((await currentTokenVersion(payload.sub)) !== payload.tv) {
    throw new DomainError("UNAUTHENTICATED", "La sesión ya no es válida; vuelve a entrar");
  }
  return payload.sub;
}

export function requireAdmin(request: FastifyRequest): string {
  try {
    return verifyAdminToken(bearerToken(request)).name;
  } catch {
    throw new DomainError("UNAUTHENTICATED", "Token de administrador inválido, vencido o ausente");
  }
}
