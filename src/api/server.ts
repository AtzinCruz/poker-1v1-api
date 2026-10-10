import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import { Prisma } from "@prisma/client";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { DomainError } from "../domain/errors.js";
import { statusForCode, toProblemJson } from "./errors.js";
import { registerSecurityHeaders } from "./securityHeaders.js";
import { authRoutes } from "./routes/auth.js";
import { matchRoutes } from "./routes/matches.js";
import { actionRoutes } from "./routes/actions.js";
import { handRoutes } from "./routes/hands.js";
import { walletRoutes } from "./routes/wallet.js";
import { adminRoutes } from "./routes/admin.js";
import { prisma } from "../infrastructure/prisma/client.js";
import { isRetryableTransactionError } from "../infrastructure/prisma/transaction.js";
import { wakeAllWaiters } from "../infrastructure/matchNotifier.js";
import { config } from "../config.js";
import { playerLimits, rateLimitedError } from "./rateLimits.js";

// P1001/P1002: BD inalcanzable · P1008: timeout · P1017: conexión cerrada · P2024: pool agotado.
const DB_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
const READINESS_TIMEOUT_MS = 1000;

/**
 * Fallas de infraestructura (no del cliente): el cliente debe reintentar, no corregir su petición.
 * Incluye un deadlock que siguió ocurriendo tras los reintentos de runTransaction (AUD-04).
 */
function isDatabaseUnavailable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientInitializationError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && DB_UNAVAILABLE_CODES.has(error.code)) ||
    isRetryableTransactionError(error)
  );
}

async function databaseIsReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), READINESS_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ServerOptions {
  logger?: boolean;
  /** Proxies de confianza delante (TRUST_PROXY_HOPS); por defecto, el de la configuración. */
  trustProxyHops?: number;
  /** false apaga los límites de tasa (RATE_LIMIT_DISABLED, solo development/test). */
  rateLimit?: boolean;
}

export async function buildServer(options: ServerOptions = {}) {
  // AUD-02: X-Forwarded-For solo vale si hay proxies de confianza delante y en la cantidad exacta
  // (TRUST_PROXY_HOPS, por defecto 0). Antes se confiaba siempre en un salto: sin proxy, ese "salto" era
  // el propio cliente, que fabricaba una IP nueva por petición y esquivaba todos los límites por IP.
  // Con N saltos, la IP es la que añadió el N-ésimo proxy contando desde el servidor.
  const trustProxyHops = options.trustProxyHops ?? config.trustProxyHops;
  const rateLimitEnabled = options.rateLimit ?? config.rateLimitEnabled;
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: trustProxyHops > 0 ? (_address: string, hop: number) => hop < trustProxyHops : false,
  });

  registerSecurityHeaders(app);
  // Los long-polls pueden esperar 25 s: sin esto, cerrar el servidor esperaría a cada uno.
  app.addHook("preClose", async () => wakeAllWaiters());

  // Compresión solo para el cliente estático (app.js 29 KB -> ~7 KB con br). Las respuestas de la API
  // quedan fuera: pesan <1 KB y algunas mezclan un secreto (el JWT del login) con texto que controla
  // el usuario (displayName), la combinación que explotan ataques tipo BREACH.
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith("/v1/")) route.compress = false;
  });
  await app.register(compress, { encodings: ["br", "gzip"], threshold: 1024 });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // El plugin solo manda la cabecera Retry-After (segundos); el §8 pide `retryAfterMs` en el cuerpo (AUD-09).
    errorResponseBuilder: (_request, context) => rateLimitedError(context.ttl),
    // Apagado (pruebas de carga/fuzz): cada límite, global o por jugador, deja pasar todo.
    ...(rateLimitEnabled ? {} : { allowList: () => true }),
  });

  app.setErrorHandler((error: FastifyError | DomainError, request, reply) => {
    if (error instanceof DomainError && error.code === "RATE_LIMITED") {
      const retryAfterMs = (error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 1000;
      reply
        .code(429)
        .header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
        .type("application/problem+json")
        .send({ ...toProblemJson(error.code, error.message), retryAfterMs });
      return;
    }
    if (error instanceof DomainError) {
      const status = statusForCode(error.code);
      reply.code(status).type("application/problem+json").send(toProblemJson(error.code, error.message, error.details));
      return;
    }
    if (error instanceof ZodError) {
      reply
        .code(400)
        .type("application/problem+json")
        .send(toProblemJson("INVALID_ACTION", "Cuerpo de solicitud inválido", error.issues));
      return;
    }
    // Errores propios de Fastify (JSON malformado, Content-Type sin body, límites de payload, etc.):
    // son errores del cliente (4xx), no del servidor — no deben caer en el 500 genérico de abajo.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      reply
        .code(error.statusCode)
        .type("application/problem+json")
        .send(toProblemJson("INVALID_ACTION", error.message));
      return;
    }
    if (isDatabaseUnavailable(error)) {
      request.log.error(error);
      reply
        .code(503)
        .header("retry-after", "2")
        .type("application/problem+json")
        .send(toProblemJson("SERVICE_UNAVAILABLE", "Servicio temporalmente no disponible; reintenta en unos segundos"));
      return;
    }
    request.log.error(error);
    reply.code(500).type("application/problem+json").send(toProblemJson("INVALID_ACTION", "Error interno del servidor"));
  });

  // Límites por cuenta, jugador y partida, que se suman al global por IP (AUD-12).
  const limits = playerLimits(app);
  await app.register(authRoutes, { limits });
  await app.register(matchRoutes, { limits });
  await app.register(actionRoutes, { limits });
  await app.register(handRoutes);
  await app.register(walletRoutes);
  await app.register(adminRoutes);

  // live: el proceso responde (para reiniciarlo si se cuelga). ready: además llega a la BD (para
  // sacarlo del balanceador si no). /health = ready, que es lo que Railway consulta por defecto.
  // Sin límite de tasa: los sondeos del orquestador no deben consumir la cuota de nadie.
  const noRateLimit = { config: { rateLimit: false } } as const;
  const readiness = async (_request: unknown, reply: import("fastify").FastifyReply) =>
    (await databaseIsReachable())
      ? reply.code(200).send({ status: "ok" })
      : reply.code(503).send({ status: "unavailable", reason: "database" });
  app.get("/health/live", noRateLimit, async () => ({ status: "ok" }));
  app.get("/health/ready", noRateLimit, readiness);
  app.get("/health", noRateLimit, readiness);

  // Cliente web estático (public/) servido desde el mismo servidor: sin CORS, un solo proceso.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  await app.register(fastifyStatic, { root: publicDir });

  return app;
}
