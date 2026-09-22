/** Códigos de error de la sección 8 del spec, usados para armar respuestas problem+json. */
export type DomainErrorCode =
  | "INVALID_ACTION"
  | "NOT_MATCH_PLAYER"
  | "MATCH_NOT_FOUND"
  | "STALE_STATE"
  | "IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_STACK"
  | "RATE_LIMITED"
  | "UNAUTHENTICATED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
