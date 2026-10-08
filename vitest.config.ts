import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Solo los tests de Vitest: e2e/ es de Playwright.
    include: ["test/**/*.test.ts"],
    globals: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ["./test/helpers/setupEnv.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "html"],
      // Medido al introducirlos: 88% sentencias, 81.5% ramas, 90% funciones, 89% líneas.
      // Un poco por debajo para no fallar por ruido, sí ante una caída real.
      thresholds: { statements: 85, branches: 78, functions: 87, lines: 86 },
    },
  },
});
