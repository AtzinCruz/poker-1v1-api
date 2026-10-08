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
  },
});
