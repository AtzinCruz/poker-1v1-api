import type { FastifyInstance } from "fastify";
import { requireAuthenticatedPlayer } from "../auth.js";
import { getHandAudit, listHandSummaries } from "../../application/handQueryService.js";
import { prisma } from "../../infrastructure/prisma/client.js";

export async function handRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/matches/:matchId/hands", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const { matchId } = request.params as { matchId: string };
    const summaries = await listHandSummaries(prisma, matchId, playerId);
    return reply.code(200).send(summaries);
  });

  app.get("/v1/matches/:matchId/hands/:handNumber", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const { matchId, handNumber } = request.params as { matchId: string; handNumber: string };
    const audit = await getHandAudit(prisma, matchId, Number(handNumber), playerId);
    return reply.code(200).send(audit);
  });
}
