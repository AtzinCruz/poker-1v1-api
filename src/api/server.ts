import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { DomainError } from "../domain/errors.js";
import { statusForCode, toProblemJson } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { matchRoutes } from "./routes/matches.js";
import { actionRoutes } from "./routes/actions.js";
import { handRoutes } from "./routes/hands.js";
import { walletRoutes } from "./routes/wallet.js";

export async function buildServer(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(rateLimit, {
    max: 120,
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
    request.log.error(error);
    reply.code(500).type("application/problem+json").send(toProblemJson("INVALID_ACTION", "Error interno del servidor"));
  });

  await app.register(authRoutes);
  await app.register(matchRoutes);
  await app.register(actionRoutes);
  await app.register(handRoutes);
  await app.register(walletRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  // Cliente web estático (public/) servido desde el mismo servidor: sin CORS, un solo proceso.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  await app.register(fastifyStatic, { root: publicDir });

  return app;
}
