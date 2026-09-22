import type { FastifyInstance } from "fastify";
import { requireAuthenticatedPlayer } from "../auth.js";
import { getWallet } from "../../application/walletService.js";

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/wallet", async (request, reply) => {
    const playerId = requireAuthenticatedPlayer(request);
    const wallet = await getWallet(playerId);
    return reply.code(200).send(wallet);
  });
}
