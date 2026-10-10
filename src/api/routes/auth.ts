import type { FastifyInstance } from "fastify";
import { adminSessionSchema, changePasswordSchema, sessionSchema } from "../schemas.js";
import { changePassword, loginOrRegister, refreshSession } from "../../application/authService.js";
import { requireAuthenticatedPlayer, requireAuthenticatedSession } from "../auth.js";
import { createAdminSession } from "../../application/adminService.js";
import type { PlayerLimits } from "../rateLimits.js";

export async function authRoutes(app: FastifyInstance, { limits }: { limits: PlayerLimits }): Promise<void> {
  // 10 intentos/min por IP y además 10/min por cuenta (AUD-02): repartir la fuerza bruta entre muchas
  // IPs ya no multiplica los intentos contra una contraseña.
  app.post(
    "/v1/auth/session",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, preHandler: limits.loginPerAccount },
    async (request, reply) => {
      const body = sessionSchema.parse(request.body);
      const session = await loginOrRegister(body.displayName, body.password, {
        beforeRegister: () => limits.registration(request),
      });
      return reply.code(200).send(session);
    },
  );

  app.post(
    "/v1/auth/password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, preHandler: limits.session },
    async (request, reply) => {
      const playerId = await requireAuthenticatedPlayer(request);
      const body = changePasswordSchema.parse(request.body);
      const session = await changePassword(playerId, body.currentPassword, body.newPassword);
      return reply.code(200).send(session);
    },
  );

  /** Token nuevo antes de que venza el actual (los tokens duran poco, §8.1 / AUD-14). */
  app.post("/v1/auth/refresh", { preHandler: limits.session }, async (request, reply) => {
    const current = await requireAuthenticatedSession(request);
    return reply.code(200).send(await refreshSession(current.sub, current.tv));
  });

  app.post(
    "/v1/auth/admin-session",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = adminSessionSchema.parse(request.body);
      const session = createAdminSession(body.displayName, body.secret);
      return reply.code(201).send(session);
    },
  );
}
