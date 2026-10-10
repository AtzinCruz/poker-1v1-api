/**
 * Ciegas incrementales (opción al crear la partida): cada BLIND_LEVEL_HANDS manos, la ciega chica y
 * la grande suben lo mismo, el 5 % del stack inicial redondeado hacia abajo. Con 300 fichas: 10/20 en
 * las manos 1-3, 25/35 en las 4-6, 40/50 en las 7-9… Así las partidas terminan aunque se juegue
 * conservador: tarde o temprano alguien no cubre la ciega grande.
 */
export const BLIND_INCREASE_PERCENT = 5;
export const BLIND_LEVEL_HANDS = 3;

export interface BlindSchedule {
  smallBlind: number;
  bigBlind: number;
  /** Fichas que suben ambas ciegas en cada nivel; 0 = ciegas fijas. */
  blindIncrement: number;
  /** Manos por nivel. */
  blindLevelHands: number;
}

export interface HandBlinds {
  small: number;
  big: number;
  /** Nivel de ciegas, desde 0. */
  level: number;
}

/** Incremento por nivel para un stack inicial: 5 % redondeado hacia abajo (300 → 15, 1000 → 50, 94 → 4). */
export function blindIncrementFor(startingStack: number): number {
  return Math.floor((startingStack * BLIND_INCREASE_PERCENT) / 100);
}

/** Ciegas de la mano `handNumber` (1, 2, 3…). */
export function blindsForHand(schedule: BlindSchedule, handNumber: number): HandBlinds {
  const level = schedule.blindIncrement > 0 ? Math.floor((Math.max(1, handNumber) - 1) / schedule.blindLevelHands) : 0;
  const raise = level * schedule.blindIncrement;
  return { small: schedule.smallBlind + raise, big: schedule.bigBlind + raise, level };
}

/** Primera mano del nivel siguiente, o null si las ciegas son fijas. */
export function nextBlindIncreaseHand(schedule: BlindSchedule, handNumber: number): number | null {
  if (schedule.blindIncrement <= 0) return null;
  const level = blindsForHand(schedule, handNumber).level;
  return (level + 1) * schedule.blindLevelHands + 1;
}
