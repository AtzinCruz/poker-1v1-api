import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

describe("health checks", () => {
  it("/health/live responde aunque la BD no esté (el proceso está vivo)", async () => {
    app = await buildServer({ logger: false });
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
  });

  it("/health/ready y /health dan 200 con la BD disponible", async () => {
    app = await buildServer({ logger: false });
    for (const url of ["/health/ready", "/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
    }
  });

  it("/health/ready y /health dan 503 si la BD no responde (antes decían ok)", async () => {
    app = await buildServer({ logger: false });
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    for (const url of ["/health/ready", "/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable", reason: "database" });
    }
  });

  it("los sondeos de salud no consumen el límite de tasa", async () => {
    app = await buildServer({ logger: false });
    for (let i = 0; i < 320; i++) {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("errores de infraestructura", () => {
  it.each(["P1001", "P2024"])("un error %s de Prisma responde 503 SERVICE_UNAVAILABLE con Retry-After", async (code) => {
    app = await buildServer({ logger: false });
    app.get("/__db-down", async () => {
      throw new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code, clientVersion: "5.22.0" });
    });
    const res = await app.inject({ method: "GET", url: "/__db-down" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.json().code).toBe("SERVICE_UNAVAILABLE");
  });

  it("un error inesperado sigue siendo 500 (no se disfraza de 503)", async () => {
    app = await buildServer({ logger: false });
    app.get("/__bug", async () => {
      throw new TypeError("bug de programación");
    });
    const res = await app.inject({ method: "GET", url: "/__bug" });
    expect(res.statusCode).toBe(500);
  });
});

describe("compresión", () => {
  it.each([
    ["br", "br"],
    ["gzip", "gzip"],
  ])("el cliente estático se sirve comprimido con %s", async (accept, expected) => {
    app = await buildServer({ logger: false });
    const plain = await app.inject({ method: "GET", url: "/app.js" });
    const res = await app.inject({ method: "GET", url: "/app.js", headers: { "accept-encoding": accept } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe(expected);
    expect(res.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
  });

  it("las respuestas de la API nunca se comprimen, aunque sean grandes (mitigación tipo BREACH)", async () => {
    app = await buildServer({ logger: false });
    const big = { filler: "x".repeat(5000) };
    app.get("/v1/__big", async () => big);
    app.get("/__big", async () => big);
    const headers = { "accept-encoding": "br, gzip" };

    const api = await app.inject({ method: "GET", url: "/v1/__big", headers });
    expect(api.headers["content-encoding"]).toBeUndefined();
    expect(api.json()).toEqual(big);

    const other = await app.inject({ method: "GET", url: "/__big", headers });
    expect(other.headers["content-encoding"]).toBe("br"); // control: la exclusión es por prefijo /v1/
  });
});
