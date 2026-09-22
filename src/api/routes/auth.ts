import type { FastifyInstance } from "fastify";
import { adminSessionSchema, devSessionSchema } from "../schemas.js";
import { createDevSession } from "../../application/authService.js";
import { createAdminSession } from "../../application/adminService.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/dev-session", async (request, reply) => {
    const body = devSessionSchema.parse(request.body);
    const session = await createDevSession(body.displayName);
    return reply.code(201).send(session);
  });

  app.post("/v1/auth/admin-session", async (request, reply) => {
    const body = adminSessionSchema.parse(request.body);
    const session = createAdminSession(body.displayName, body.secret);
    return reply.code(201).send(session);
  });
}
