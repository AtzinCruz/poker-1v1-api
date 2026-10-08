import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestApp, registerPlayer, authHeaders, TEST_PASSWORD } from "../helpers/testApp.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { hashPassword, verifyPassword } from "../../src/infrastructure/auth/password.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

function login(displayName: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/auth/session", payload: { displayName, password } });
}

async function adminHeaders() {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/admin-session",
    payload: { displayName: "root", secret: process.env.ADMIN_SECRET },
  });
  return { authorization: `Bearer ${res.json().token}` };
}

describe("login con contraseña por jugador", () => {
  it("un nombre nuevo crea la cuenta y la contraseña nunca se guarda en claro", async () => {
    const res = await login("alice", "una-contraseña-larga");
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();

    const row = await prisma.player.findUniqueOrThrow({ where: { displayName: "alice" } });
    expect(row.passwordHash).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(row.passwordHash).not.toContain("una-contraseña-larga");
  });

  it("el mismo nombre con la contraseña correcta devuelve el mismo jugador", async () => {
    const first = (await login("alice", "una-contraseña-larga")).json();
    const second = (await login("alice", "una-contraseña-larga")).json();
    expect(second.player.id).toBe(first.player.id);
  });

  it("no se puede suplantar a otro jugador sabiendo solo su nombre", async () => {
    const alice = await registerPlayer(app, "victima");
    const bob = await registerPlayer(app, "rival");
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/matches",
        headers: authHeaders(alice),
        payload: { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: bob.id },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/v1/matches/${created.id}/join`,
      headers: authHeaders(bob),
      payload: { joinToken: created.joinToken },
    });

    // El rival intenta entrar como la víctima para abandonar y llevarse todo el stack.
    const attempt = await login("victima", "adivinando-1234");
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json().token).toBeUndefined();

    // Y el mensaje no distingue "no existe" de "contraseña incorrecta".
    const unknown = await login("nadie-existe", "x".repeat(10));
    expect(unknown.statusCode).toBe(200); // un nombre libre simplemente se registra...
    const wrongForExisting = await login("victima", "otra-contraseña-1");
    expect(wrongForExisting.json().message).toBe("Nombre o contraseña incorrectos");

    expect((await prisma.match.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("IN_PROGRESS");
  });

  it("rechaza contraseñas demasiado cortas o enormes", async () => {
    expect((await login("alice", "corta")).statusCode).toBe(400);
    expect((await login("alice", "x".repeat(73))).statusCode).toBe(400);
    expect(await prisma.player.count({ where: { displayName: "alice" } })).toBe(0);
  });

  it("dos altas simultáneas del mismo nombre: solo una gana, la otra recibe 401 (sin 500)", async () => {
    const [a, b] = await Promise.all([login("carrera", "contraseña-uno-1"), login("carrera", "contraseña-dos-2")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
    expect(await prisma.player.count({ where: { displayName: "carrera" } })).toBe(1);
  });

  it("el login tiene un límite estricto de intentos por IP", async () => {
    await login("objetivo", "la-contraseña-real-1");
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await login("objetivo", `intento-numero-${i}`)).statusCode);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  });
});

describe("cuentas anteriores a las contraseñas", () => {
  it("una cuenta sin contraseña NO se puede reclamar entrando: nadie se adelanta a su dueña/o", async () => {
    await prisma.player.create({ data: { displayName: "antigua" } }); // sin passwordHash

    const attempt = await login("antigua", "mi-nueva-contraseña");
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json().message).toBe("Nombre o contraseña incorrectos"); // igual que cualquier otra falla
    expect((await prisma.player.findUniqueOrThrow({ where: { displayName: "antigua" } })).passwordHash).toBeNull();
  });

  it("el admin asigna una contraseña temporal: sirve una vez generada, queda registrada y no se guarda en claro", async () => {
    await prisma.player.create({ data: { displayName: "antigua" } });
    const owner = await prisma.player.findUniqueOrThrow({ where: { displayName: "antigua" } });
    const headers = await adminHeaders();

    const reset = await app.inject({ method: "POST", url: `/v1/admin/players/${owner.id}/reset-password`, headers });
    expect(reset.statusCode).toBe(200);
    const { temporaryPassword, hasPassword } = reset.json();
    expect(hasPassword).toBe(true);
    expect(temporaryPassword).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{4}$/);

    const row = await prisma.player.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).not.toContain(temporaryPassword);
    const records = await prisma.adminAction.findMany({ where: { playerId: owner.id } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ adminName: "root", type: "RESET_PASSWORD" });
    expect(JSON.stringify(records[0])).not.toContain(temporaryPassword);

    expect((await login("antigua", "otra-cosa-cualquiera")).statusCode).toBe(401);
    expect((await login("antigua", temporaryPassword)).statusCode).toBe(200);
  });

  it("restablecer revoca las sesiones anteriores (un token robado deja de servir)", async () => {
    const owner = await registerPlayer(app, "olvidadiza");
    const before = await app.inject({ method: "GET", url: "/v1/wallet", headers: authHeaders(owner) });
    expect(before.statusCode).toBe(200);

    const headers = await adminHeaders();
    const reset = await app.inject({ method: "POST", url: `/v1/admin/players/${owner.id}/reset-password`, headers });
    expect(reset.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/v1/wallet", headers: authHeaders(owner) });
    expect(after.statusCode).toBe(401);
    expect((await login("olvidadiza", TEST_PASSWORD)).statusCode).toBe(401); // la anterior ya no vale
    const fresh = await login("olvidadiza", reset.json().temporaryPassword);
    expect(fresh.statusCode).toBe(200);
    const ok = await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${fresh.json().token}` } });
    expect(ok.statusCode).toBe(200);
  });

  it("restablecer contraseña exige token de admin", async () => {
    const owner = await registerPlayer(app, "protegida");
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/players/${owner.id}/reset-password`,
      headers: { authorization: `Bearer ${owner.token}`, "idempotency-key": randomUUID() },
    });
    expect(res.statusCode).toBe(401);
    const row = await prisma.player.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.tokenVersion).toBe(0);
    expect(await verifyPassword(TEST_PASSWORD, row.passwordHash!)).toBe(true);
  });
});

describe("cambio de contraseña", () => {
  function change(token: string, currentPassword: string, newPassword: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword, newPassword },
    });
  }

  it("cambia la contraseña, revoca los tokens anteriores y entrega una sesión nueva", async () => {
    const me = await registerPlayer(app, "cambiante");
    const res = await change(me.token, TEST_PASSWORD, "contraseña-nueva-456");
    expect(res.statusCode).toBe(200);
    const fresh = res.json().token as string;

    expect((await app.inject({ method: "GET", url: "/v1/wallet", headers: authHeaders(me) })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${fresh}` } })).statusCode,
    ).toBe(200);
    expect((await login("cambiante", TEST_PASSWORD)).statusCode).toBe(401);
    expect((await login("cambiante", "contraseña-nueva-456")).statusCode).toBe(200);
  });

  it("exige la contraseña actual correcta y una nueva de largo válido", async () => {
    const me = await registerPlayer(app, "cambiante");
    expect((await change(me.token, "no-es-esta-1234", "contraseña-nueva-456")).statusCode).toBe(401);
    expect((await change(me.token, TEST_PASSWORD, "corta")).statusCode).toBe(400);
    expect((await login("cambiante", TEST_PASSWORD)).statusCode).toBe(200);
  });

  it("sin token no se puede cambiar", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: { currentPassword: TEST_PASSWORD, newPassword: "contraseña-nueva-456" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("hash de contraseñas", () => {
  it("usa sal aleatoria y verifica en ambos sentidos", async () => {
    const a = await hashPassword("misma-contraseña");
    const b = await hashPassword("misma-contraseña");
    expect(a).not.toBe(b);
    expect(await verifyPassword("misma-contraseña", a)).toBe(true);
    expect(await verifyPassword("otra", a)).toBe(false);
    expect(await verifyPassword("misma-contraseña", "basura")).toBe(false);
  });
});
