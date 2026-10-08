import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildServer({ logger: false });
  await app.ready();
  return app;
}

export const TEST_PASSWORD = "contraseña-de-prueba-123";

export interface TestPlayer {
  token: string;
  id: string;
  displayName: string;
}

export async function registerPlayer(app: FastifyInstance, displayName: string): Promise<TestPlayer> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { displayName, password: TEST_PASSWORD },
  });
  const body = res.json();
  return { token: body.token, id: body.player.id, displayName: body.player.displayName };
}

export function authHeaders(player: TestPlayer, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${player.token}`,
    "idempotency-key": idempotencyKey ?? randomUUID(),
  };
}
