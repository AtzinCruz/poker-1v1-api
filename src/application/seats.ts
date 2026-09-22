import type { Hand, Match } from "@prisma/client";
import { DomainError } from "../domain/errors.js";

export type Slot = "player1" | "player2";

export function slotOfPlayer(match: Pick<Match, "player1Id" | "player2Id">, playerId: string): Slot {
  if (playerId === match.player1Id) return "player1";
  if (playerId === match.player2Id) return "player2";
  throw new DomainError("NOT_MATCH_PLAYER", "El jugador no pertenece a esta partida");
}

export function otherSlot(slot: Slot): Slot {
  return slot === "player1" ? "player2" : "player1";
}

export function playerIdOfSlot(match: Pick<Match, "player1Id" | "player2Id">, slot: Slot): string {
  const id = slot === "player1" ? match.player1Id : match.player2Id;
  if (!id) throw new DomainError("INVALID_ACTION", "La partida todavía no tiene dos jugadores");
  return id;
}

export interface SlotHandView {
  contribution: number;
  roundStartContribution: number;
  discarded: boolean;
  folded: boolean;
  allIn: boolean;
  actedInRound: boolean;
  /** Códigos de carta ("AS", "10H", ...), no objetos Card. */
  cards: string[];
}

export function readSlot(hand: Hand, slot: Slot): SlotHandView {
  if (slot === "player1") {
    return {
      contribution: hand.player1Contribution,
      roundStartContribution: hand.player1RoundStartContribution,
      discarded: hand.player1Discarded,
      folded: hand.player1Folded,
      allIn: hand.player1AllIn,
      actedInRound: hand.player1ActedInRound,
      cards: hand.player1Cards as unknown as string[],
    };
  }
  return {
    contribution: hand.player2Contribution,
    roundStartContribution: hand.player2RoundStartContribution,
    discarded: hand.player2Discarded,
    folded: hand.player2Folded,
    allIn: hand.player2AllIn,
    actedInRound: hand.player2ActedInRound,
    cards: hand.player2Cards as unknown as string[],
  };
}

/** Payload parcial para `prisma.hand.update({ data })`, con los nombres de columna reales según el slot. */
export function slotUpdate(slot: Slot, patch: Partial<SlotHandView>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (suffix: string, value: unknown) => {
    out[`${slot}${suffix}`] = value;
  };
  if (patch.contribution !== undefined) set("Contribution", patch.contribution);
  if (patch.roundStartContribution !== undefined) set("RoundStartContribution", patch.roundStartContribution);
  if (patch.discarded !== undefined) set("Discarded", patch.discarded);
  if (patch.folded !== undefined) set("Folded", patch.folded);
  if (patch.allIn !== undefined) set("AllIn", patch.allIn);
  if (patch.actedInRound !== undefined) set("ActedInRound", patch.actedInRound);
  if (patch.cards !== undefined) set("Cards", patch.cards);
  return out;
}

export function matchStackField(slot: Slot): "player1Stack" | "player2Stack" {
  return slot === "player1" ? "player1Stack" : "player2Stack";
}

export function getMatchStack(match: Match, slot: Slot): number {
  const value = slot === "player1" ? match.player1Stack : match.player2Stack;
  if (value === null || value === undefined) {
    throw new DomainError("INVALID_ACTION", "La partida todavía no tiene stacks inicializados");
  }
  return value;
}
