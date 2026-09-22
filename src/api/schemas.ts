import { z } from "zod";

export const devSessionSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
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
