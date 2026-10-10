import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.js";
import { requireIdempotencyKey } from "../idempotencyHeader.js";
import { addBalanceSchema } from "../schemas.js";
import { addPlayerBalance, auditName, listAllMatches, listAllPlayers, resetPlayerPassword } from "../../application/adminService.js";

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

  /** Idempotency-Key obligatoria (AUD-20): un doble clic o un reintento no acredita dos veces. */
  app.post("/v1/admin/players/:playerId/add-balance", async (request, reply) => {
    const admin = requireAdmin(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { playerId } = request.params as { playerId: string };
    const body = addBalanceSchema.parse(request.body);
    const player = await addPlayerBalance(playerId, body.amount, auditName(admin), idempotencyKey);
    return reply.code(200).send(player);
  });

  app.post("/v1/admin/players/:playerId/reset-password", async (request, reply) => {
    const admin = requireAdmin(request);
    const { playerId } = request.params as { playerId: string };
    const player = await resetPlayerPassword(playerId, auditName(admin));
    return reply.code(200).send(player);
  });
}
