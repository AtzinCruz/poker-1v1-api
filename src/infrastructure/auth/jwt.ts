import jwt from "jsonwebtoken";
import { config } from "../../config.js";

export interface AuthTokenPayload {
  sub: string; // playerId
  displayName: string;
}

/**
 * Stub de un "módulo de identidad" real (fuera de alcance de esta entrega). Emite JWT válidos
 * que el resto de la API consume igual que si vinieran de un IdP externo.
 */
export function signPlayerToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyPlayerToken(token: string): AuthTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
}
