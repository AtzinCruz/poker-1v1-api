import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export async function logEvent(
  tx: Tx,
  params: {
    matchId: string;
    handId?: string;
    type: string;
    stateVersion: number;
    publicPayload: unknown;
    player1Payload?: unknown;
    player2Payload?: unknown;
  },
): Promise<void> {
  await tx.gameEvent.create({
    data: {
      matchId: params.matchId,
      handId: params.handId,
      type: params.type,
      stateVersion: params.stateVersion,
      publicPayload: params.publicPayload as Prisma.InputJsonValue,
      player1Payload: params.player1Payload as Prisma.InputJsonValue | undefined,
      player2Payload: params.player2Payload as Prisma.InputJsonValue | undefined,
    },
  });
}
