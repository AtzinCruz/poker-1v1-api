import type { FastifyInstance } from "fastify";
import { requireAuthenticatedPlayer } from "../auth.js";
import { requireIdempotencyKey } from "../idempotencyHeader.js";
import { createMatchSchema, joinMatchSchema } from "../schemas.js";
import { createMatch, joinMatch, resignMatch, listPendingInvitations } from "../../application/matchService.js";
import { getMatchViewForPlayer } from "../../application/handQueryService.js";

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/invitations", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const invitations = await listPendingInvitations(playerId);
    return reply.code(200).send(invitations);
  });

  app.post("/v1/matches", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = createMatchSchema.parse(request.body);

    const result = await createMatch({ creatorId: playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });

  app.post("/v1/matches/:matchId/join", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };
    const body = joinMatchSchema.parse(request.body);

    const result = await joinMatch({ matchId, playerId, idempotencyKey, body });
    return reply.code(result.status).send(result.body);
  });

  app.get("/v1/matches/:matchId", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const { matchId } = request.params as { matchId: string };
    const view = await getMatchViewForPlayer(matchId, playerId);
    return reply.code(200).send(view);
  });

  app.post("/v1/matches/:matchId/resign", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { matchId } = request.params as { matchId: string };

    const result = await resignMatch({ matchId, playerId, idempotencyKey });
    return reply.code(result.status).send(result.body);
  });
}
