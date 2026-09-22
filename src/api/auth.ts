import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { verifyPlayerToken } from "../infrastructure/auth/jwt.js";

export function requireAuthenticatedPlayer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new DomainError("UNAUTHENTICATED", "Falta el encabezado Authorization: Bearer <jwt>");
  }
  const token = header.slice("Bearer ".length);
  try {
    return verifyPlayerToken(token).sub;
  } catch {
    throw new DomainError("UNAUTHENTICATED", "JWT inválido o vencido");
  }
}
