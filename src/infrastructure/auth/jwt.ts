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

export interface AdminTokenPayload {
  admin: true;
  name: string;
}

/** Token de administrador: solo se emite si el caller conoce ADMIN_SECRET (ver authService.ts). */
export function signAdminToken(name: string): string {
  return jwt.sign({ admin: true, name } satisfies AdminTokenPayload, config.jwtSecret, { expiresIn: "4h" });
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  const payload = jwt.verify(token, config.jwtSecret) as Partial<AdminTokenPayload>;
  if (payload.admin !== true) {
    throw new Error("No es un token de administrador");
  }
  return payload as AdminTokenPayload;
}
