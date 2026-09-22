import { DomainError } from "./errors.js";
import type { ActionType, HandPhase } from "./types.js";

/** Tabla de la sección 3 del spec: qué tipo de acción es válida en cada fase de la mano. */
const ACTIONS_ALLOWED_BY_PHASE: Record<HandPhase, ActionType[]> = {
  HAND_SETUP: [],
  BETTING_PRE_DRAW: ["BET", "ALL_IN", "FOLD"],
  DRAW: ["DRAW"],
  BETTING_POST_DRAW: ["BET", "ALL_IN", "FOLD"],
  SHOWDOWN: [],
  HAND_FINISHED: [],
};

export function assertPhaseAllowsAction(phase: HandPhase, actionType: ActionType): void {
  if (!ACTIONS_ALLOWED_BY_PHASE[phase].includes(actionType)) {
    throw new DomainError("INVALID_ACTION", `La acción ${actionType} no es válida en la fase ${phase}`);
  }
}

/** BETTING_PRE_DRAW cerrada → DRAW; BETTING_POST_DRAW cerrada → SHOWDOWN. */
export function nextPhaseAfterBettingRoundClosed(
  phase: "BETTING_PRE_DRAW" | "BETTING_POST_DRAW",
): "DRAW" | "SHOWDOWN" {
  return phase === "BETTING_PRE_DRAW" ? "DRAW" : "SHOWDOWN";
}
