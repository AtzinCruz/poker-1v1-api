import { describe, expect, it } from "vitest";
import { assertSecretsAreStrong } from "../../src/config.js";

const STRONG_JWT = "a".repeat(40);
const STRONG_ADMIN = "b".repeat(20);

describe("assertSecretsAreStrong", () => {
  it("sin NODE_ENV (p. ej. un despliegue que lo olvida) rechaza los secretos de ejemplo", () => {
    expect(() => assertSecretsAreStrong({ nodeEnv: undefined, jwtSecret: "dev-secret-change-me", adminSecret: null })).toThrow(/JWT_SECRET/);
    expect(() => assertSecretsAreStrong({ nodeEnv: undefined, jwtSecret: STRONG_JWT, adminSecret: "cambia-esto-en-produccion" })).toThrow(/ADMIN_SECRET/);
  });

  it("en production rechaza secretos cortos", () => {
    expect(() => assertSecretsAreStrong({ nodeEnv: "production", jwtSecret: "corto", adminSecret: null })).toThrow(/JWT_SECRET/);
    expect(() => assertSecretsAreStrong({ nodeEnv: "production", jwtSecret: STRONG_JWT, adminSecret: "corta" })).toThrow(/ADMIN_SECRET/);
  });

  it("acepta secretos fuertes, y los de ejemplo solo en development/test", () => {
    expect(() => assertSecretsAreStrong({ nodeEnv: undefined, jwtSecret: STRONG_JWT, adminSecret: STRONG_ADMIN })).not.toThrow();
    expect(() => assertSecretsAreStrong({ nodeEnv: "production", jwtSecret: STRONG_JWT, adminSecret: null })).not.toThrow();
    for (const nodeEnv of ["development", "test"]) {
      expect(() => assertSecretsAreStrong({ nodeEnv, jwtSecret: "dev-secret-change-me", adminSecret: "cambia-esto-en-produccion" })).not.toThrow();
    }
  });
});
