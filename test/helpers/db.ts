import { prisma } from "../../src/infrastructure/prisma/client.js";

export async function resetDatabase(): Promise<void> {
  await prisma.gameEvent.deleteMany();
  await prisma.action.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.hand.deleteMany();
  await prisma.match.deleteMany();
  await prisma.player.deleteMany();
}
