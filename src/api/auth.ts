import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { verifyAdminToken, verifyPlayerToken } from "../infrastructure/auth/jwt.js";

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new DomainError("UNAUTHENTICATED", "Falta el encabezado Authorization: Bearer <jwt>");
  }
  return header.slice("Bearer ".length);
}

export function requireAuthenticatedPlayer(request: FastifyRequest): string {
  try {
    return verifyPlayerToken(bearerToken(request)).sub;
  } catch {
    throw new DomainError("UNAUTHENTICATED", "JWT inválido o vencido");
  }
}

export function requireAdmin(request: FastifyRequest): string {
  try {
    return verifyAdminToken(bearerToken(request)).name;
  } catch {
    throw new DomainError("UNAUTHENTICATED", "Token de administrador inválido, vencido o ausente");
  }
}
