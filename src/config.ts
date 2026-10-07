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

/**
 * Seguro por defecto: los secretos de ejemplo solo se toleran si el entorno se declara explícitamente
 * como development o test. Un despliegue que olvide fijar NODE_ENV queda en modo estricto.
 */
export function assertSecretsAreStrong(env: { nodeEnv: string | undefined; jwtSecret: string; adminSecret: string | null }): void {
  if (env.nodeEnv === "development" || env.nodeEnv === "test") return;
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
}

assertSecretsAreStrong({ nodeEnv: process.env.NODE_ENV, jwtSecret, adminSecret });

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  // Clave para entrar al panel de administración (POST /v1/auth/admin-session). Si no está
  // configurada, ese endpoint queda deshabilitado (nadie puede entrar como admin).
  adminSecret,
};
