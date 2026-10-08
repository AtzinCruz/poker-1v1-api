import { z } from "zod";

/** El stack inicial debe alcanzar al menos para este número de ciegas grandes. */
export const MIN_BIG_BLINDS_PER_STACK = 5;

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

export const createMatchSchema = z.object({
  startingStack: z.number().int().min(100).max(100_000),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  turnTimeoutSeconds: z.number().int().min(15).max(120).optional(),
  inviteeId: z.string().min(1),
}).refine((v) => v.smallBlind < v.bigBlind, {
  message: "smallBlind debe ser menor que bigBlind",
  path: ["smallBlind"],
}).refine((v) => v.bigBlind * MIN_BIG_BLINDS_PER_STACK <= v.startingStack, {
  // Sin este tope una ciega grande >= stack termina la partida al unirse el rival, sin jugar ninguna mano.
  message: `bigBlind no puede superar 1/${MIN_BIG_BLINDS_PER_STACK} de startingStack`,
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
