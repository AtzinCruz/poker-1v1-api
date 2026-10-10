import type { FastifyInstance } from "fastify";
import { requireAuthenticatedPlayer } from "../auth.js";
import { requireIdempotencyKey } from "../idempotencyHeader.js";
import { submitActionSchema } from "../schemas.js";
import { submitAction } from "../../application/actionService.js";
import type { PlayerLimits } from "../rateLimits.js";

export async function actionRoutes(app: FastifyInstance, { limits }: { limits: PlayerLimits }): Promise<void> {
  app.post("/v1/matches/:matchId/actions", { preHandler: limits.matchCommand }, async (request, reply) => {
    const playerId = await requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };
    const body = submitActionSchema.parse(request.body);

    const result = await submitAction({ matchId, playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });
}
