import type { FastifyInstance } from "fastify";
import { adminSessionSchema, sessionSchema } from "../schemas.js";
import { loginOrRegister } from "../../application/authService.js";
import { createAdminSession } from "../../application/adminService.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 10 intentos/min por IP: frena la adivinanza de contraseñas sin molestar a un uso normal.
  app.post(
    "/v1/auth/session",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = sessionSchema.parse(request.body);
      const session = await loginOrRegister(body.displayName, body.password);
      return reply.code(200).send(session);
    },
  );

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
