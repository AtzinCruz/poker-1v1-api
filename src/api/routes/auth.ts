import type { FastifyInstance } from "fastify";
import { devSessionSchema } from "../schemas.js";
import { createDevSession } from "../../application/authService.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/dev-session", async (request, reply) => {
    const body = devSessionSchema.parse(request.body);
    const session = await createDevSession(body.displayName);
    return reply.code(201).send(session);
  });
}
