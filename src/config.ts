// Carga .env si existe (Node 20.6+), salvo que el entorno ya traiga DATABASE_URL (p. ej. los
// tests de integración, que fijan TEST_DATABASE_URL antes de importar este módulo y no quieren
// que el .env de desarrollo los pise).
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // sin .env — se asume que las variables ya están en el entorno
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

const jwtSecret = required("JWT_SECRET");
const adminSecret = process.env.ADMIN_SECRET || null;

const PLACEHOLDER_JWT_SECRET = "dev-secret-change-me";
const PLACEHOLDER_ADMIN_SECRET = "cambia-esto-en-produccion";

function isLocalEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

/** Una cuenta de administrador con nombre propio: su clave la identifica (AUD-20). */
export interface AdminAccount {
  name: string;
  secret: string;
}

/**
 * ADMIN_ACCOUNTS="ana:clave-de-ana,beto:clave-de-beto". Cada admin entra con SU clave, así que el
 * nombre que queda en AdminAction está autenticado, y quitar una cuenta (o cambiarle la clave)
 * revoca sus tokens sin tocar a los demás.
 */
export function parseAdminAccounts(raw: string | undefined): AdminAccount[] {
  if (!raw?.trim()) return [];
  const accounts = raw.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (separator <= 0 || !name || !secret) {
      throw new Error('ADMIN_ACCOUNTS debe tener la forma "nombre:clave,nombre2:clave2"');
    }
    return { name, secret };
  });
  if (new Set(accounts.map((a) => a.name)).size !== accounts.length) {
    throw new Error("ADMIN_ACCOUNTS tiene nombres repetidos");
  }
  return accounts;
}

/**
 * Seguro por defecto: los secretos de ejemplo solo se toleran si el entorno se declara explícitamente
 * como development o test. Un despliegue que olvide fijar NODE_ENV queda en modo estricto.
 */
export function assertSecretsAreStrong(env: {
  nodeEnv: string | undefined;
  jwtSecret: string;
  adminSecret: string | null;
  adminAccounts?: AdminAccount[];
}): void {
  if (isLocalEnv(env.nodeEnv)) return;
  if (env.jwtSecret === PLACEHOLDER_JWT_SECRET || env.jwtSecret.length < 32) {
    throw new Error(
      "JWT_SECRET es débil o es el valor de ejemplo: usa al menos 32 caracteres aleatorios (o define NODE_ENV=development en local)",
    );
  }
  if (env.adminSecret && (env.adminSecret === PLACEHOLDER_ADMIN_SECRET || env.adminSecret.length < 16)) {
    throw new Error(
      "ADMIN_SECRET es débil o es el valor de ejemplo: usa al menos 16 caracteres aleatorios (o define NODE_ENV=development en local)",
    );
  }
  for (const account of env.adminAccounts ?? []) {
    if (account.secret === PLACEHOLDER_ADMIN_SECRET || account.secret.length < 16) {
      throw new Error(`La clave de admin de "${account.name}" (ADMIN_ACCOUNTS) es débil: usa al menos 16 caracteres aleatorios`);
    }
  }
}

/**
 * Cuántos proxies de confianza hay delante (AUD-02). 0 (por defecto) = ninguno: se ignora
 * X-Forwarded-For y la IP es la del socket. Con un salto de más, cualquier cliente fabrica una IP
 * nueva por petición y esquiva los límites; con uno de menos, todos comparten la IP del proxy.
 */
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("TRUST_PROXY_HOPS debe ser un entero entre 0 y 10 (proxies de confianza delante del servidor)");
  }
  return hops;
}

/**
 * RATE_LIMIT_DISABLED=true apaga los límites de tasa (pruebas de carga y fuzz desde una sola IP).
 * Solo se acepta en development/test: un despliegue nunca debe quedar sin límites por descuido.
 */
export function parseRateLimitEnabled(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw !== "true") return true;
  if (!isLocalEnv(nodeEnv)) {
    throw new Error("RATE_LIMIT_DISABLED=true solo se permite con NODE_ENV=development o test");
  }
  return false;
}

/** Días de retención; 0 = no purgar nunca. */
function parseRetentionDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`${name} debe ser un entero >= 0 (días; 0 = no purgar)`);
  }
  return days;
}

const adminAccounts = parseAdminAccounts(process.env.ADMIN_ACCOUNTS);

assertSecretsAreStrong({ nodeEnv: process.env.NODE_ENV, jwtSecret, adminSecret, adminAccounts });

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  // Clave compartida del panel de administración (POST /v1/auth/admin-session). Con ella el nombre
  // del admin lo declara quien entra; ADMIN_ACCOUNTS da a cada admin su propia clave. Sin ninguna
  // de las dos, nadie puede entrar como admin.
  adminSecret,
  adminAccounts,
  trustProxyHops: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS),
  rateLimitEnabled: parseRateLimitEnabled(process.env.RATE_LIMIT_DISABLED, process.env.NODE_ENV),
  // AUD-19: partidas terminadas (con sus manos, acciones y eventos) y registros de admin se purgan
  // pasado este tiempo.
  matchRetentionDays: parseRetentionDays("MATCH_RETENTION_DAYS", 180),
  adminActionRetentionDays: parseRetentionDays("ADMIN_ACTION_RETENTION_DAYS", 730),
};
