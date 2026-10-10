import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.js";

/**
 * Pruebas largas de la auditoría (AUDITORIA.md): fuzz de la API con invariantes y propiedades del motor
 * de apuestas. Van aparte de `npm test` por lo que tardan; las reproducciones de cada hallazgo ya
 * corregido pasaron a test/integration como regresión. Ejecutar con:
 *
 *   npx vitest run -c test/audit/vitest.config.ts
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const merged = mergeConfig(
  base,
  defineConfig({
    root,
    test: {
      testTimeout: 180_000,
      hookTimeout: 30_000,
      coverage: { enabled: false },
    },
  }),
);

// mergeConfig concatena arrays: si `include` fuera por ahí, también correría toda la suite de `npm test`.
merged.test!.include = ["test/audit/**/*.audit.ts"];

export default merged;
