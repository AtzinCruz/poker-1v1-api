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

// P1001/P1002: BD inalcanzable · P1008: timeout · P1017: conexión cerrada · P2024: pool agotado.
const DB_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
const READINESS_TIMEOUT_MS = 1000;

/** Fallas de infraestructura (no del cliente): el cliente debe reintentar, no corregir su petición. */
function isDatabaseUnavailable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientInitializationError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && DB_UNAVAILABLE_CODES.has(error.code))
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

export async function buildServer(options: { logger?: boolean } = {}) {
  // trustProxy (hop < 1) = se confía en UN solo salto (el proxy de Railway) y la IP del cliente es la que ese
  // proxy añadió al final de X-Forwarded-For. Con `true` se confiaba en toda la cadena y el cliente
  // podía fabricar una IP distinta por request para esquivar los límites de tasa.
  const app = Fastify({ logger: options.logger ?? true, trustProxy: (_address: string, hop: number) => hop < 1 });

  registerSecurityHeaders(app);

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
  });

  app.setErrorHandler((error: FastifyError | DomainError, request, reply) => {
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
    if (error.statusCode === 429) {
      reply
        .code(429)
        .type("application/problem+json")
        .send({ ...toProblemJson("RATE_LIMITED", "Demasiadas solicitudes"), retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs });
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

  await app.register(authRoutes);
  await app.register(matchRoutes);
  await app.register(actionRoutes);
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
