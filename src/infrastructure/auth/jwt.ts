import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";

const ALGORITHM = "HS256" as const;

export interface AuthTokenPayload {
  sub: string; // playerId
  displayName: string;
  tv: number; // Player.tokenVersion al emitirlo: si la cuenta cambia de versión, el token queda revocado
}

/**
 * Stub de un "módulo de identidad" real (fuera de alcance de esta entrega). Emite JWT válidos
 * que el resto de la API consume igual que si vinieran de un IdP externo.
 */
export function signPlayerToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { algorithm: ALGORITHM, audience: "player", expiresIn: "12h" });
}

export function verifyPlayerToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: [ALGORITHM], audience: "player" });
  if (typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub || typeof payload.tv !== "number") {
    throw new Error("Token de jugador inválido");
  }
  return payload as unknown as AuthTokenPayload;
}

export interface AdminTokenPayload {
  name: string;
}

/**
 * Los tokens de admin se firman con una clave derivada de JWT_SECRET *y* ADMIN_SECRET: conocer solo
 * JWT_SECRET (p. ej. el valor por defecto de .env.example) no alcanza para fabricar un token de admin.
 * Además llevan audience "admin", por lo que nunca se aceptan como token de jugador (y viceversa).
 */
function adminSigningKey(): string {
  if (!config.adminSecret) {
    throw new Error("El panel de administración no está habilitado");
  }
  return createHmac("sha256", config.jwtSecret).update(`admin-token-key:${config.adminSecret}`).digest("hex");
}

export function signAdminToken(name: string): string {
  return jwt.sign({ name } satisfies AdminTokenPayload, adminSigningKey(), {
    algorithm: ALGORITHM,
    audience: "admin",
    expiresIn: "4h",
  });
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  const payload = jwt.verify(token, adminSigningKey(), { algorithms: [ALGORITHM], audience: "admin" });
  if (typeof payload === "string" || typeof payload.name !== "string") {
    throw new Error("Token de administrador inválido");
  }
  return payload as unknown as AdminTokenPayload;
}
