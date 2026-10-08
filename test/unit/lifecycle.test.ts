import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createShutdown } from "../../src/api/lifecycle.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await app?.close().catch(() => {});
  app = null;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("apagado ordenado", () => {
  it("espera la petición en curso y el barrido antes de desconectar y salir con 0", async () => {
    app = Fastify({ logger: false, forceCloseConnections: false });
    const request = deferred();
    app.get("/slow", async () => {
      await request.promise;
      return { ok: true };
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 50));

    const order: string[] = [];
    const maintenance = deferred();
    const exit = vi.fn((code: number) => order.push(`exit:${code}`));
    const shutdown = createShutdown({
      app,
      stopTimers: () => order.push("timers"),
      pendingWork: () => maintenance.promise.then(() => order.push("maintenance")),
      disconnect: async () => {
        order.push("disconnect");
      },
      exit,
      graceMs: 5000,
    });

    const done = shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled(); // sigue esperando la petición

    request.resolve();
    expect(await inFlight).toBe(200); // la petición en curso terminó bien
    maintenance.resolve();
    await done;

    expect(order).toEqual(["timers", "maintenance", "disconnect", "exit:0"]);
  });

  it("varias señales no repiten el apagado", async () => {
    app = Fastify({ logger: false });
    const disconnect = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdown({ app, stopTimers: () => {}, pendingWork: () => null, disconnect, exit, graceMs: 1000 });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("si algo se cuelga, sale con 1 al cumplirse el tiempo de gracia", async () => {
    vi.useFakeTimers();
    app = Fastify({ logger: false });
    const exit = vi.fn();
    const shutdown = createShutdown({
      app,
      stopTimers: () => {},
      pendingWork: () => new Promise(() => {}), // un barrido que nunca termina
      disconnect: async () => {},
      exit,
      graceMs: 1000,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
