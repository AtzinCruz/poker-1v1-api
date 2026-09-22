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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  // Clave para entrar al panel de administración (POST /v1/auth/admin-session). Si no está
  // configurada, ese endpoint queda deshabilitado (nadie puede entrar como admin).
  adminSecret: process.env.ADMIN_SECRET || null,
};
