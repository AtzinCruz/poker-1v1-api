export type MatchStatus = "WAITING_FOR_OPPONENT" | "IN_PROGRESS" | "MATCH_FINISHED" | "CANCELLED";

export type HandPhase =
  | "HAND_SETUP"
  | "BETTING_PRE_DRAW"
  | "DRAW"
  | "BETTING_POST_DRAW"
  | "SHOWDOWN"
  | "HAND_FINISHED";

export type ActionType = "DRAW" | "BET" | "ALL_IN" | "FOLD";

export type FinishReason = "RESIGN" | "INSUFFICIENT_STACK" | "DISCONNECT_TIMEOUT";

export type HandWinReason = "FOLD" | "SHOWDOWN" | "SPLIT";

export interface MatchRules {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  turnTimeoutSeconds: number;
  maxDiscard: number;
}
