import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile();
} catch {
  // sin .env (CI): las variables ya vienen del entorno
}

const PORT = 3200;
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Define TEST_DATABASE_URL para correr los tests E2E");

/**
 * E2E contra la API real y la BD de test (nunca la de desarrollo). Cada test crea jugadores con
 * nombres únicos, así que no necesita limpiar la BD y puede convivir con los tests de Vitest.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node --import tsx src/api/start.ts",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET ?? "e2e-only-jwt-secret",
      ADMIN_SECRET: process.env.ADMIN_SECRET ?? "e2e-only-admin-secret",
    },
  },
});
