import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

type Tx = Prisma.TransactionClient;

/** 40P01: deadlock · 40001: fallo de serialización. Postgres revierte la transacción entera. */
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);
const MAX_ATTEMPTS = 3;

/**
 * Prisma lo informa de tres formas según la consulta: P2034 (escrituras del ORM que Prisma
 * reconoce), P2010 con `meta.code` (SQL crudo) o un error "desconocido" con el SQLSTATE en el texto.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return true;
    const sqlState = (error.meta as { code?: unknown } | undefined)?.code;
    return error.code === "P2010" && typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /code: "(40P01|40001)"/.test(error.message);
  }
  return false;
}

/**
 * `prisma.$transaction` con red de seguridad (AUD-04): el orden global de locks (locks.ts) evita los
 * deadlocks conocidos, pero si aun así Postgres aborta la transacción por uno, se repite entera (es
 * seguro: no quedó nada aplicado, ni siquiera los NOTIFY). Si se agotan los intentos, el error llega
 * al manejador, que responde 503 con Retry-After en vez de un 500.
 */
export async function runTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, options);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
    }
  }
}
