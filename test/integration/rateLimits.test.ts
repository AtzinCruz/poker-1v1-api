/**
 * Límites de tasa (regresión de AUD-02, AUD-06, AUD-09, AUD-12 y AUD-22).
 * `app.inject` llega siempre desde 127.0.0.1, igual que un cliente conectado directo, sin proxy.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { MAX_WAITS_PER_MATCH } from "../../src/api/routes/matches.js";
import { createTestApp } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { act, bearer, makePlayer, startMatch, view } from "../helpers/scenario.js";

let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

/** Servidor detrás de `hops` proxies de confianza (TRUST_PROXY_HOPS): ahí X-Forwarded-For sí cuenta. */
async function appBehindProxy(hops: number): Promise<FastifyInstance> {
  const server = await buildServer({ logger: false, trustProxyHops: hops });
  await server.ready();
  extraApps.push(server);
  return server;
}

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(extraApps.splice(0).map((a) => a.close()));
});

afterAll(async () => {
  await app?.close();
});

const login = (server: FastifyInstance, displayName: string, password: string, ip?: string) =>
  server.inject({
    method: "POST",
    url: "/v1/auth/session",
    headers: ip ? { "x-forwarded-for": ip } : {},
    payload: { displayName, password },
  });

describe("X-Forwarded-For sin proxy de confianza (AUD-02)", () => {
  it("50 logins de admin con una XFF inventada distinta cada uno: corta en el 6.º", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/admin-session",
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        payload: { displayName: "atacante", secret: `adivinanza-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });

  it("con un proxy de confianza configurado, cada IP real tiene su propio cupo", async () => {
    const proxied = await appBehindProxy(1);
    // El proxy añade la IP real al final; lo que el cliente pone a la izquierda no cuenta.
    const fromA = [];
    for (let i = 0; i < 6; i++) {
      fromA.push((await proxied.inject({
        method: "POST",
        url: "/v1/auth/admin-session",
        headers: { "x-forwarded-for": `ip-falsa-${i}, 198.51.100.1` },
        payload: { displayName: "x", secret: "mal" },
      })).statusCode);
    }
    expect(fromA).toEqual([401, 401, 401, 401, 401, 429]);
    const fromB = await proxied.inject({
      method: "POST",
      url: "/v1/auth/admin-session",
      headers: { "x-forwarded-for": "198.51.100.2" },
      payload: { displayName: "x", secret: "mal" },
    });
    expect(fromB.statusCode).toBe(401);
  });
});

describe("límites por cuenta, jugador y partida (AUD-02, AUD-12)", () => {
  it("50 intentos contra la misma cuenta desde 50 IPs reales distintas: corta en el 11.º", async () => {
    const proxied = await appBehindProxy(1);
    expect((await login(proxied, "victima", "clave-real-123", "198.51.100.200")).statusCode).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      statuses.push((await login(proxied, "victima", `adivinanza-${i}`, `198.51.100.${i}`)).statusCode);
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(9);
    expect(statuses.filter((s) => s === 429)).toHaveLength(41);
  });

  it("los comandos sobre una partida tienen cupo por jugador y partida; otra partida no se ve afectada", async () => {
    const alice = await makePlayer("alice", 5000);
    const bob = await makePlayer("bob", 5000);
    const m1 = await startMatch(app, alice, bob);
    const m2 = await startMatch(app, alice, bob);

    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      // Versión vieja a propósito: no cambia nada, solo consume cupo.
      statuses.push((await act(app, m1, alice, { type: "BET", amount: 20, actionVersion: 0 })).statusCode);
    }
    expect(statuses.slice(0, 60).every((s) => s === 409)).toBe(true);
    expect(statuses[60]).toBe(429);

    const other = await act(app, m2, alice, { type: "BET", amount: 20, actionVersion: 0 });
    expect(other.statusCode).toBe(409);
    // El rival en la misma partida tampoco: el cupo es de Alice.
    expect((await act(app, m1, bob, { type: "BET", amount: 20, actionVersion: 0 })).statusCode).toBe(409);
  });

  it("límite de altas de cuentas por IP: 10 por hora (AUD-22)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stamp = randomUUID().slice(0, 6);
    for (let i = 0; i < 10; i++) {
      expect((await login(app, `nuevo-${stamp}-${i}`, "contraseña-larga-1")).statusCode).toBe(200);
    }
    // Pasado el minuto se renuevan los límites por minuto, pero no el de altas por hora.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await login(app, `nuevo-${stamp}-10`, "contraseña-larga-1")).statusCode).toBe(429);
    // Entrar con una cuenta que ya existe sigue funcionando.
    expect((await login(app, `nuevo-${stamp}-0`, "contraseña-larga-1")).statusCode).toBe(200);
  });
});

describe("429 RATE_LIMITED (AUD-09)", () => {
  it("el cuerpo trae retryAfterMs (§8) y la cabecera Retry-After", async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await login(app, "rl-victima", `intento-${i}-xx`);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    const body = last!.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("también en los límites por partida", async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    let last;
    for (let i = 0; i < 61; i++) last = await act(app, m, alice, { type: "BET", amount: 20, actionVersion: 0 });
    expect(last!.statusCode).toBe(429);
    expect(last!.json().retryAfterMs).toBeGreaterThan(0);
    expect(last!.headers["retry-after"]).toBeDefined();
  });
});

describe("tope de long-polls abiertos (AUD-06)", () => {
  it(`más de ${MAX_WAITS_PER_MATCH} esperas del mismo jugador en una partida: la siguiente responde al instante`, async () => {
    const alice = await makePlayer("alice");
    const bob = await makePlayer("bob");
    const m = await startMatch(app, alice, bob);
    const since = (await view(app, m, bob)).stateVersion;
    const poll = () => app.inject({ method: "GET", url: `/v1/matches/${m}?since=${since}`, headers: bearer(bob) });

    const waiting = Array.from({ length: MAX_WAITS_PER_MATCH }, poll);
    await new Promise((r) => setTimeout(r, 300)); // que queden esperando
    const started = Date.now();
    const extra = await poll();
    expect(extra.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);

    // Un cambio en la partida despierta a las que esperaban.
    expect((await act(app, m, alice, { type: "BET", amount: 20, actionVersion: since }, randomUUID())).statusCode).toBe(200);
    const woken = await Promise.all(waiting);
    expect(woken.map((r) => r.json().stateVersion > since)).toEqual(Array(MAX_WAITS_PER_MATCH).fill(true));
  });
});

describe("límites apagados para pruebas de carga", () => {
  it("rateLimit: false deja pasar todo", async () => {
    const unlimited = await buildServer({ logger: false, rateLimit: false });
    await unlimited.ready();
    extraApps.push(unlimited);
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await unlimited.inject({
        method: "POST",
        url: "/v1/auth/admin-session",
        payload: { displayName: "x", secret: "mal" },
      })).statusCode);
    }
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});
