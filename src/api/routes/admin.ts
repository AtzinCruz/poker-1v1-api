import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.js";
import { addBalanceSchema } from "../schemas.js";
import { addPlayerBalance, listAllMatches, listAllPlayers } from "../../application/adminService.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/players", async (request, reply) => {
    requireAdmin(request);
    const players = await listAllPlayers();
    return reply.code(200).send(players);
  });

  app.get("/v1/admin/matches", async (request, reply) => {
    requireAdmin(request);
    const matches = await listAllMatches();
    return reply.code(200).send(matches);
  });

  app.post("/v1/admin/players/:playerId/add-balance", async (request, reply) => {
    requireAdmin(request);
    const { playerId } = request.params as { playerId: string };
    const body = addBalanceSchema.parse(request.body);
    const player = await addPlayerBalance(playerId, body.amount);
    return reply.code(200).send(player);
  });
}
