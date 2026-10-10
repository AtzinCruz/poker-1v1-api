import type { ActionType, Hand, Match, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface ActionRecordInput {
  handId: string;
  matchId: string;
  playerId: string;
  type: ActionType;
  amount?: number;
  discardedIndexes?: number[];
  /** stateVersion sobre el que se aplicó: el estado anterior. */
  actionVersion: number;
  isAuto?: boolean;
  /** Idempotency-Key de la petición; las acciones automáticas no tienen. */
  idempotencyKey?: string;
}

/** Foto pública de la partida tras una acción (sin cartas): lo que §8.1 llama "estado posterior". */
export function stateSnapshot(match: Match, hand: Hand | null) {
  return {
    stateVersion: match.stateVersion,
    status: match.status,
    handNumber: match.handNumber,
    phase: hand?.phase ?? null,
    pot: hand ? hand.player1Contribution + hand.player2Contribution : 0,
    stacks: { player1: match.player1Stack, player2: match.player2Stack },
  };
}

/**
 * Registro inmutable de una acción (§8.1, AUD-10): estado anterior (`actionVersion`), estado posterior
 * (`stateAfter`, ya con las transiciones automáticas que provocó), la Idempotency-Key y la marca de
 * tiempo. Se escribe después de aplicar la acción, en la misma transacción.
 */
export async function recordAction(
  tx: Tx,
  input: ActionRecordInput,
  after: { match: Match; hand: Hand | null },
): Promise<{ id: string }> {
  return tx.action.create({
    data: { ...input, stateAfter: stateSnapshot(after.match, after.hand) },
    select: { id: true },
  });
}
