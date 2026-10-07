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

if (process.env.NODE_ENV === "production") {
  if (jwtSecret === "dev-secret-change-me" || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET es débil (o el valor por defecto): usa al menos 32 caracteres aleatorios en producción");
  }
  if (adminSecret && adminSecret.length < 16) {
    throw new Error("ADMIN_SECRET es demasiado corta: usa al menos 16 caracteres aleatorios en producción");
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  // Clave para entrar al panel de administración (POST /v1/auth/admin-session). Si no está
  // configurada, ese endpoint queda deshabilitado (nadie puede entrar como admin).
  adminSecret,
};
