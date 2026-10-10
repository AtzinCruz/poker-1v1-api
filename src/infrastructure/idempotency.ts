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
 *
 * La clave se reserva ANTES de ejecutar nada (AUD-05): `INSERT … ON CONFLICT DO NOTHING` espera a que
 * termine cualquier otra transacción que esté usando la misma clave y después se lee lo que esa dejó.
 * Antes se buscaba, se ejecutaba y se insertaba al final: dos peticiones con la misma clave sobre
 * partidas distintas (locks distintos) chocaban en la unicidad y una respondía 500.
 *
 * Por eso cada comando llama a esto antes de bloquear partidas o jugadores, y `handler` hace los
 * bloqueos (orden global: clave → partidas → jugadores; ver application/locks.ts).
 */
export async function withIdempotency<T>(
  tx: Tx,
  params: { playerId: string; key: string; scope: string; requestBody: unknown },
  handler: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; idempotentReplay: boolean }> {
  const requestHash = hashRequest(params.scope, params.requestBody);
  const where = { playerId_key: { playerId: params.playerId, key: params.key } };

  // Dos vueltas como máximo: si la fila con la que chocó se purgó justo después (TTL), se reintenta la reserva.
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await tx.idempotencyRecord.createMany({
      // responseStatus/responseBody se completan abajo, en esta misma transacción: nadie ve el marcador.
      data: [{ playerId: params.playerId, key: params.key, requestHash, responseStatus: 0, responseBody: {} }],
      skipDuplicates: true,
    });
    if (reserved.count === 1) break;

    const existing = await tx.idempotencyRecord.findUnique({ where });
    if (!existing) continue;
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La misma Idempotency-Key ya se usó con otra solicitud (cuerpo, endpoint o partida distintos)",
      );
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, idempotentReplay: true };
  }

  const result = await handler();

  await tx.idempotencyRecord.update({
    where,
    data: { responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
  });

  return { ...result, idempotentReplay: false };
}
