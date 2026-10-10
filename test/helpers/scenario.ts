/**
 * Escenarios de partida para los tests de integración y de auditoría: jugadores creados directo en la
 * BD (sin el límite de login), atajos de API, invariantes de fichas y una conexión `pg` aparte para
 * retener locks y forzar intercalados exactos entre transacciones.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { signPlayerToken } from "../../src/infrastructure/auth/jwt.js";

export interface AuditPlayer {
  id: string;
  token: string;
  displayName: string;
}

export const RULES = { startingStack: 1000, smallBlind: 10, bigBlind: 20 } as const;

/** Crea el jugador directamente en la BD (sin pasar por el login, que tiene límite de 10/min por IP). */
export async function makePlayer(name: string, balance = 1000): Promise<AuditPlayer> {
  const p = await prisma.player.create({
    data: { displayName: `${name}-${randomUUID().slice(0, 8)}`, fictionalBalance: balance },
  });
  return {
    id: p.id,
    displayName: p.displayName,
    token: signPlayerToken({ sub: p.id, displayName: p.displayName, tv: p.tokenVersion }),
  };
}

export const bearer = (p: AuditPlayer) => ({ authorization: `Bearer ${p.token}` });
export const cmd = (p: AuditPlayer, key: string = randomUUID()) => ({ ...bearer(p), "idempotency-key": key });

export async function createMatch(
  app: FastifyInstance,
  creator: AuditPlayer,
  invitee: AuditPlayer,
  rules: Record<string, number> = RULES,
) {
  return app.inject({ method: "POST", url: "/v1/matches", headers: cmd(creator), payload: { ...rules, inviteeId: invitee.id } });
}

export async function startMatch(
  app: FastifyInstance,
  creator: AuditPlayer,
  invitee: AuditPlayer,
  rules: Record<string, number> = RULES,
): Promise<string> {
  const created = await createMatch(app, creator, invitee, rules);
  if (created.statusCode !== 201) throw new Error(`create → ${created.statusCode} ${created.body}`);
  const { id, joinToken } = created.json();
  const joined = await app.inject({
    method: "POST",
    url: `/v1/matches/${id}/join`,
    headers: cmd(invitee),
    payload: { joinToken },
  });
  if (joined.statusCode !== 200) throw new Error(`join → ${joined.statusCode} ${joined.body}`);
  return id as string;
}

export async function view(app: FastifyInstance, matchId: string, p: AuditPlayer) {
  const res = await app.inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: bearer(p) });
  if (res.statusCode !== 200) throw new Error(`view → ${res.statusCode} ${res.body}`);
  return res.json();
}

export function act(app: FastifyInstance, matchId: string, p: AuditPlayer, body: Record<string, unknown>, key?: string) {
  return app.inject({ method: "POST", url: `/v1/matches/${matchId}/actions`, headers: cmd(p, key), payload: body });
}

export function resign(app: FastifyInstance, matchId: string, p: AuditPlayer) {
  return app.inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: cmd(p) });
}

export async function walletOf(p: AuditPlayer) {
  const row = await prisma.player.findUniqueOrThrow({ where: { id: p.id } });
  return { available: row.fictionalBalance, blocked: row.blockedBalance };
}

/** Fichas totales del sistema: disponible + bloqueado de todos los jugadores. Debe ser constante. */
export async function totalChips(): Promise<number> {
  const agg = await prisma.player.aggregate({ _sum: { fictionalBalance: true, blockedBalance: true } });
  return (agg._sum.fictionalBalance ?? 0) + (agg._sum.blockedBalance ?? 0);
}

/**
 * Invariante de la reserva: el saldo bloqueado de cada jugador es exactamente `startingStack` por cada
 * partida suya sin liquidar (esperando rival como creador, o en curso).
 */
export async function blockedMismatches(): Promise<string[]> {
  const players = await prisma.player.findMany();
  const open = await prisma.match.findMany({ where: { status: { in: ["WAITING_FOR_OPPONENT", "IN_PROGRESS"] } } });
  const out: string[] = [];
  for (const p of players) {
    const expected = open
      .filter((m) => m.player1Id === p.id || m.player2Id === p.id)
      .reduce((sum, m) => sum + m.startingStack, 0);
    if (expected !== p.blockedBalance) out.push(`${p.displayName}: blocked=${p.blockedBalance} esperado=${expected}`);
  }
  return out;
}

export async function expireCurrentTurn(matchId: string): Promise<void> {
  await prisma.hand.updateMany({
    where: { matchId, phase: { in: ["DRAW", "BETTING_PRE_DRAW", "BETTING_POST_DRAW"] } },
    data: { turnExpiresAt: new Date(Date.now() - 1000) },
  });
}

/** Conexión `pg` aparte (fuera del pool de Prisma) para retener locks y forzar intercalados exactos. */
export async function rawClient(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.delete("schema");
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Espera hasta que haya `n` sesiones de esta BD bloqueadas esperando un lock. */
export async function waitForLockWaiters(client: pg.Client, n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // pg_stat_activity se congela durante la transacción que lo consulta: hay que soltar el snapshot.
    await client.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.c) >= n) return;
    if (Date.now() > deadline) throw new Error(`timeout esperando ${n} sesiones bloqueadas (hay ${rows[0]!.c})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
