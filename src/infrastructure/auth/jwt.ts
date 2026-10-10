import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";

const ALGORITHM = "HS256" as const;

/**
 * Vida del token de jugador (§8.1 "JWT con expiración corta", AUD-14). El cliente lo renueva antes de
 * que venza con POST /v1/auth/refresh, que vuelve a comprobar que la sesión no fue revocada.
 */
export const PLAYER_TOKEN_TTL_SECONDS = 60 * 60;
export const ADMIN_TOKEN_TTL_SECONDS = 4 * 60 * 60;

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
  return jwt.sign(payload, config.jwtSecret, { algorithm: ALGORITHM, audience: "player", expiresIn: PLAYER_TOKEN_TTL_SECONDS });
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
  /**
   * true = se entró con la clave compartida (ADMIN_SECRET) y `name` lo declaró quien entró; false = cuenta
   * propia de ADMIN_ACCOUNTS, cuyo nombre está autenticado por su clave.
   */
  shared: boolean;
}

/**
 * Los tokens de admin se firman con una clave derivada de JWT_SECRET *y* de la clave del admin: conocer
 * solo JWT_SECRET no alcanza para fabricarlos. Con ADMIN_ACCOUNTS la clave es la de cada cuenta, así que
 * quitar una cuenta o cambiarle la clave revoca sus tokens y los de nadie más (AUD-20). Además llevan
 * audience "admin", por lo que nunca se aceptan como token de jugador (y viceversa).
 */
function adminSigningKey(payload: AdminTokenPayload): string {
  if (payload.shared) {
    if (!config.adminSecret) throw new Error("El acceso con clave compartida no está habilitado");
    return createHmac("sha256", config.jwtSecret).update(`admin-token-key:${config.adminSecret}`).digest("hex");
  }
  const account = config.adminAccounts.find((a) => a.name === payload.name);
  if (!account) throw new Error("Esa cuenta de administrador ya no existe");
  return createHmac("sha256", config.jwtSecret).update(`admin-account-key:${account.name}:${account.secret}`).digest("hex");
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload satisfies AdminTokenPayload, adminSigningKey(payload), {
    algorithm: ALGORITHM,
    audience: "admin",
    expiresIn: ADMIN_TOKEN_TTL_SECONDS,
  });
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  // La clave depende de quién dice ser el token: se lee sin verificar SOLO para elegirla; la firma
  // (con el algoritmo fijado) se comprueba justo después con esa clave.
  const claimed = jwt.decode(token);
  if (!claimed || typeof claimed === "string" || typeof claimed.name !== "string" || typeof claimed.shared !== "boolean") {
    throw new Error("Token de administrador inválido");
  }
  const payload = jwt.verify(token, adminSigningKey({ name: claimed.name, shared: claimed.shared }), {
    algorithms: [ALGORITHM],
    audience: "admin",
  });
  if (typeof payload === "string" || payload.name !== claimed.name || payload.shared !== claimed.shared) {
    throw new Error("Token de administrador inválido");
  }
  return { name: claimed.name, shared: claimed.shared };
}
