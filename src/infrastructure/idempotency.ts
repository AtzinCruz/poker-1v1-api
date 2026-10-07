import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { DomainError } from "../domain/errors.js";

/** El hash cubre el scope (operación + partida) además del body: la misma clave no puede reusarse en otro endpoint o partida. */
export function hashRequest(scope: string, body: unknown): string {
  return createHash("sha256").update(JSON.stringify({ scope, body: body ?? null })).digest("hex");
}

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Envoltura de idempotencia para POST de comandos (sección 5 del spec).
 * Misma (playerId, key) + mismo body → devuelve la respuesta original sin reejecutar `handler`.
 * Misma clave + body distinto → 409 IDEMPOTENCY_CONFLICT.
 */
export async function withIdempotency<T>(
  tx: Tx,
  params: { playerId: string; key: string; scope: string; requestBody: unknown },
  handler: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; idempotentReplay: boolean }> {
  const requestHash = hashRequest(params.scope, params.requestBody);

  const existing = await tx.idempotencyRecord.findUnique({
    where: { playerId_key: { playerId: params.playerId, key: params.key } },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La misma Idempotency-Key ya se usó con otra solicitud (cuerpo, endpoint o partida distintos)",
      );
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, idempotentReplay: true };
  }

  const result = await handler();

  await tx.idempotencyRecord.create({
    data: {
      playerId: params.playerId,
      key: params.key,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as Prisma.InputJsonValue,
    },
  });

  return { ...result, idempotentReplay: false };
}
