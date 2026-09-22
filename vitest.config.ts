import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ["./test/helpers/setupEnv.ts"],
    fileParallelism: false,
  },
});
