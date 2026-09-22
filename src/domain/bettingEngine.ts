import { DomainError } from "./errors.js";

/** Heads-up: solo hay dos asientos. 0 y 1 se asignan por el caller (normalmente 0=botón). */
export type Seat = 0 | 1;

export interface BettingRoundState {
  currentBet: number;
  lastRaiseSize: number;
  contributions: [number, number];
  stacks: [number, number];
  allIn: [boolean, boolean];
  actedThisRound: [boolean, boolean];
  toAct: Seat;
}

export interface BettingRoundResult {
  state: BettingRoundState;
  closed: boolean;
  /** Fichas devueltas a `seat` por exceso no igualable (all-in parcial del rival). */
  refund?: { seat: Seat; amount: number };
}

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function setAt<T>(tuple: readonly [T, T], seat: Seat, value: T): [T, T] {
  const copy: [T, T] = [tuple[0], tuple[1]];
  copy[seat] = value;
  return copy;
}

function markActed(state: BettingRoundState, seat: Seat): BettingRoundState {
  return { ...state, actedThisRound: setAt(state.actedThisRound, seat, true) };
}

function seatTotalAvailable(state: BettingRoundState, seat: Seat): number {
  return state.contributions[seat] + state.stacks[seat];
}

export function createBettingRound(params: {
  stacks: [number, number];
  contributions: [number, number];
  currentBet: number;
  lastRaiseSize: number;
  toAct: Seat;
}): BettingRoundState {
  return {
    currentBet: params.currentBet,
    lastRaiseSize: params.lastRaiseSize,
    contributions: [params.contributions[0], params.contributions[1]],
    stacks: [params.stacks[0], params.stacks[1]],
    allIn: [params.stacks[0] === 0, params.stacks[1] === 0],
    actedThisRound: [false, false],
    toAct: params.toAct,
  };
}

/**
 * Determina si la ronda cierra tras la última acción y, de no cerrar, a quién le toca actuar.
 * Reglas (sección 2.4 del spec): ambos actuaron y aportaciones igualadas, o hay all-in y no
 * queda decisión de apuesta posible para el rival.
 */
function closeOrAdvance(state: BettingRoundState): BettingRoundResult {
  let closed: boolean;

  if (state.allIn[0] || state.allIn[1]) {
    const activeSeat: Seat | null = state.allIn[0] && state.allIn[1] ? null : state.allIn[0] ? 1 : 0;
    closed = activeSeat === null ? true : state.actedThisRound[activeSeat];
  } else {
    closed =
      state.actedThisRound[0] &&
      state.actedThisRound[1] &&
      state.contributions[0] === state.contributions[1];
  }

  const next = closed ? state : { ...state, toAct: otherSeat(state.toAct) };
  return { state: next, closed };
}

/** Reembolsa a quien contribuyó de más cuando el rival quedó all-in por menos y ya no puede igualar. */
function refundUncalledExcess(result: BettingRoundResult): BettingRoundResult {
  if (!result.closed) return result;
  const { contributions, allIn } = result.state;
  if (contributions[0] === contributions[1]) return result;

  const higher: Seat = contributions[0] > contributions[1] ? 0 : 1;
  const lower = otherSeat(higher);
  if (!allIn[lower]) return result;

  const excess = contributions[higher] - contributions[lower];
  const state: BettingRoundState = {
    ...result.state,
    contributions: setAt(contributions, higher, contributions[higher] - excess),
    stacks: setAt(result.state.stacks, higher, result.state.stacks[higher] + excess),
  };
  return { ...result, state, refund: { seat: higher, amount: excess } };
}

/**
 * Acción "Bet" del spec: amount=0 es CHECK (solo si no hay apuesta pendiente),
 * amount=currentBet es CALL, amount>currentBet es RAISE (debe cumplir el raise mínimo).
 */
export function applyCheckOrBet(state: BettingRoundState, seat: Seat, amount: number): BettingRoundResult {
  if (seat !== state.toAct) {
    throw new DomainError("INVALID_ACTION", "No es el turno de este jugador");
  }
  if (state.allIn[seat]) {
    throw new DomainError("INVALID_ACTION", "El jugador ya está all-in, no puede volver a apostar");
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw new DomainError("INVALID_ACTION", "El importe debe ser un entero no negativo");
  }

  const toCall = state.currentBet - state.contributions[seat];

  if (amount === 0) {
    if (toCall > 0) {
      throw new DomainError("INVALID_ACTION", "Hay una apuesta pendiente; use CALL (amount) o FOLD, no CHECK");
    }
    return closeOrAdvance(markActed(state, seat));
  }

  const maxAvailable = seatTotalAvailable(state, seat);
  if (amount > maxAvailable) {
    throw new DomainError("INSUFFICIENT_STACK", "El jugador no tiene fichas suficientes para ese importe");
  }
  if (amount < state.currentBet) {
    throw new DomainError(
      "INVALID_ACTION",
      "El importe debe igualar o superar la apuesta actual; use ALL_IN si no alcanza",
    );
  }

  const opponent = otherSeat(seat);
  const isRaise = amount > state.currentBet;
  const isAllIn = amount === maxAvailable;

  if (isRaise && !isAllIn) {
    if (state.allIn[opponent]) {
      throw new DomainError("INVALID_ACTION", "No se puede subir a un rival que ya está all-in");
    }
    const raiseSize = amount - state.currentBet;
    if (raiseSize < state.lastRaiseSize) {
      throw new DomainError("INVALID_ACTION", `El raise debe ser de al menos ${state.lastRaiseSize} fichas adicionales`);
    }
  }

  const delta = amount - state.contributions[seat];
  let next: BettingRoundState = {
    ...state,
    contributions: setAt(state.contributions, seat, amount),
    stacks: setAt(state.stacks, seat, state.stacks[seat] - delta),
  };
  if (isAllIn) next.allIn = setAt(next.allIn, seat, true);

  if (isRaise) {
    const raiseSize = amount - state.currentBet;
    next.currentBet = amount;
    if (raiseSize >= state.lastRaiseSize) next.lastRaiseSize = raiseSize;
    next.actedThisRound = state.allIn[opponent] ? next.actedThisRound : [false, false];
  }
  next = markActed(next, seat);

  return refundUncalledExcess(closeOrAdvance(next));
}

/** Acción "All-in": aporta todo el saldo restante del jugador, sea o no un raise completo. */
export function applyAllIn(state: BettingRoundState, seat: Seat): BettingRoundResult {
  if (seat !== state.toAct) {
    throw new DomainError("INVALID_ACTION", "No es el turno de este jugador");
  }
  if (state.allIn[seat]) {
    throw new DomainError("INVALID_ACTION", "El jugador ya está all-in");
  }
  const total = seatTotalAvailable(state, seat);
  if (total <= state.contributions[seat]) {
    throw new DomainError("INSUFFICIENT_STACK", "No hay saldo disponible para ir all-in");
  }

  const opponent = otherSeat(seat);
  const opponentAllIn = state.allIn[opponent];

  let next: BettingRoundState = {
    ...state,
    contributions: setAt(state.contributions, seat, total),
    stacks: setAt(state.stacks, seat, 0),
    allIn: setAt(state.allIn, seat, true),
  };

  if (total > state.currentBet) {
    const raiseSize = total - state.currentBet;
    next.currentBet = total;
    if (!opponentAllIn && raiseSize >= state.lastRaiseSize) next.lastRaiseSize = raiseSize;
    next.actedThisRound = opponentAllIn ? next.actedThisRound : [false, false];
  }
  next = markActed(next, seat);

  return refundUncalledExcess(closeOrAdvance(next));
}

export type LegalBettingAction =
  | { type: "CHECK" }
  | { type: "CALL"; amount: number }
  | { type: "RAISE"; min: number; max: number }
  | { type: "ALL_IN" }
  | { type: "FOLD" };

/** Acciones legales para `seat`, usadas para armar `legalActions` en la vista de partida. */
export function legalBettingActions(state: BettingRoundState, seat: Seat): LegalBettingAction[] {
  if (state.toAct !== seat || state.allIn[seat]) return [];

  const toCall = state.currentBet - state.contributions[seat];
  const maxAvailable = seatTotalAvailable(state, seat);
  const actions: LegalBettingAction[] = [];

  if (toCall <= 0) {
    actions.push({ type: "CHECK" });
  } else if (state.currentBet <= maxAvailable) {
    // `amount` es el total de la ronda a enviar en BET (mismo significado que en la API),
    // no el delta que falta por igualar — así el cliente puede reenviarlo tal cual.
    actions.push({ type: "CALL", amount: state.currentBet });
  }

  const opponent = otherSeat(seat);
  if (!state.allIn[opponent]) {
    const minRaiseTotal = state.currentBet + state.lastRaiseSize;
    if (minRaiseTotal < maxAvailable) {
      actions.push({ type: "RAISE", min: minRaiseTotal, max: maxAvailable });
    }
  }

  if (maxAvailable > state.contributions[seat]) {
    actions.push({ type: "ALL_IN" });
  }

  actions.push({ type: "FOLD" });
  return actions;
}
