import { z } from "zod";

/** Ciegas predeterminadas del §2.1 (pequeña 10 / grande 20) cuando la petición no las indica. */
export const DEFAULT_SMALL_BLIND = 10;
export const DEFAULT_BIG_BLIND = 20;
/** Fichas con las que entra cada jugador si la petición no lo indica (decisión de producto: 300). */
export const DEFAULT_STARTING_STACK = 300;

export const sessionSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  // 72 = límite práctico habitual para contraseñas; evita enviar payloads enormes al hash.
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(72),
});

export const adminSessionSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  secret: z.string().min(1),
});

export const addBalanceSchema = z.object({
  amount: z.number().int().positive().max(1_000_000),
});

/**
 * §6.1: startingStack 100–100 000 (300 por defecto), 0 < smallBlind < bigBlind, turnTimeoutSeconds
 * 15–120 (60 por defecto); las ciegas son opcionales y por defecto 10/20 (§2.1, AUD-17).
 * `incrementalBlinds`: cada 3 manos ambas ciegas suben el 5 % del stack inicial (domain/blinds.ts).
 * Lo único que se añade es
 * que la ciega grande quepa en el stack inicial: si no, la partida terminaría al unirse el rival sin
 * repartir ninguna mano. (Antes se exigía bigBlind × 5 ≤ startingStack, más estricto que el spec.)
 */
export const createMatchSchema = z.object({
  startingStack: z.number().int().min(100).max(100_000).default(DEFAULT_STARTING_STACK),
  smallBlind: z.number().int().positive().default(DEFAULT_SMALL_BLIND),
  bigBlind: z.number().int().positive().default(DEFAULT_BIG_BLIND),
  turnTimeoutSeconds: z.number().int().min(15).max(120).optional(),
  incrementalBlinds: z.boolean().default(false),
  inviteeId: z.string().min(1),
}).refine((v) => v.smallBlind < v.bigBlind, {
  message: "smallBlind debe ser menor que bigBlind",
  path: ["smallBlind"],
}).refine((v) => v.bigBlind <= v.startingStack, {
  message: "bigBlind no puede superar startingStack: no se podría repartir ninguna mano",
  path: ["bigBlind"],
});

export const joinMatchSchema = z.object({
  joinToken: z.string().min(1),
});

export const submitActionSchema = z
  .object({
    type: z.enum(["DRAW", "BET", "ALL_IN", "FOLD"]),
    amount: z.number().int().min(0).optional(),
    discardedIndexes: z.array(z.number().int().min(0).max(4)).max(5).optional(),
    actionVersion: z.number().int().nonnegative(),
  })
  .refine((v) => v.type !== "BET" || typeof v.amount === "number", {
    message: "amount es obligatorio para type=BET",
    path: ["amount"],
  });

export type SubmitActionBody = z.infer<typeof submitActionSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(72),
});
