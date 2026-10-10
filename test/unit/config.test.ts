import { describe, expect, it } from "vitest";
import { assertSecretsAreStrong, parseAdminAccounts, parseRateLimitEnabled, parseTrustProxyHops } from "../../src/config.js";

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

describe("proxies de confianza (AUD-02)", () => {
  it("por defecto 0: X-Forwarded-For no cuenta salvo que se configure", () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops("")).toBe(0);
    expect(parseTrustProxyHops("2")).toBe(2);
  });

  it("rechaza valores que no son un número de saltos", () => {
    for (const bad of ["true", "-1", "1.5", "11", "uno"]) expect(() => parseTrustProxyHops(bad)).toThrow(/TRUST_PROXY_HOPS/);
  });
});

describe("apagar los límites de tasa", () => {
  it("solo en development/test", () => {
    expect(parseRateLimitEnabled(undefined, "production")).toBe(true);
    expect(parseRateLimitEnabled("true", "test")).toBe(false);
    expect(() => parseRateLimitEnabled("true", "production")).toThrow(/RATE_LIMIT_DISABLED/);
    expect(() => parseRateLimitEnabled("true", undefined)).toThrow(/RATE_LIMIT_DISABLED/);
  });
});

describe("cuentas de admin (AUD-20)", () => {
  it("lee nombre:clave separados por comas", () => {
    expect(parseAdminAccounts(undefined)).toEqual([]);
    expect(parseAdminAccounts("ana:clave-de-ana-123456, beto:otra:con:dos-puntos")).toEqual([
      { name: "ana", secret: "clave-de-ana-123456" },
      { name: "beto", secret: "otra:con:dos-puntos" },
    ]);
    expect(() => parseAdminAccounts("sin-clave")).toThrow(/ADMIN_ACCOUNTS/);
    expect(() => parseAdminAccounts("ana:a,ana:b")).toThrow(/repetidos/);
  });

  it("fuera de development/test exige claves fuertes también por cuenta", () => {
    const weak = [{ name: "ana", secret: "corta" }];
    expect(() => assertSecretsAreStrong({ nodeEnv: "production", jwtSecret: STRONG_JWT, adminSecret: null, adminAccounts: weak })).toThrow(/ana/);
    expect(() =>
      assertSecretsAreStrong({ nodeEnv: "production", jwtSecret: STRONG_JWT, adminSecret: null, adminAccounts: [{ name: "ana", secret: STRONG_ADMIN }] }),
    ).not.toThrow();
  });
});
