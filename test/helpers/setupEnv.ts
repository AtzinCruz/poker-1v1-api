try {
  process.loadEnvFile();
} catch {
  // sin .env local — se asume que las variables ya están en el entorno (CI)
}

// Los tests de integración siempre corren contra la base de datos de test, nunca la de desarrollo.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-for-integration-tests";
