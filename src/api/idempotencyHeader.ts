import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  const value = Array.isArray(key) ? key[0] : key;
  if (!value || !UUID_RE.test(value)) {
    throw new DomainError("INVALID_ACTION", "Falta el encabezado Idempotency-Key (UUID) o es inválido");
  }
  return value;
}
