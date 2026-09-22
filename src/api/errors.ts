import type { DomainErrorCode } from "../domain/errors.js";

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  INVALID_ACTION: 400,
  UNAUTHENTICATED: 401,
  NOT_MATCH_PLAYER: 403,
  MATCH_NOT_FOUND: 404,
  STALE_STATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_STACK: 422,
  RATE_LIMITED: 429,
};

export function statusForCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface ProblemJson {
  type: string;
  code: DomainErrorCode;
  message: string;
  details?: unknown;
  currentState?: unknown;
}

export function toProblemJson(code: DomainErrorCode, message: string, details?: unknown): ProblemJson {
  const currentState =
    details && typeof details === "object" && "currentState" in details
      ? (details as { currentState?: unknown }).currentState
      : undefined;
  return {
    type: `https://api.ejemplo.com/v1/errors/${code}`,
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(currentState !== undefined ? { currentState } : {}),
  };
}
