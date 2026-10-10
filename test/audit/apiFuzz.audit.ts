/**
 * Fuzz de extremo a extremo por la API (un solo hilo: las carreras van en concurrency.audit.ts).
 * Juega FUZZ_HANDS manos mezclando acciones legales, ilegales, repeticiones idempotentes, timeouts y
 * abandonos, y tras CADA paso comprueba los invariantes contra la BD:
 *   - stack1 + stack2 + pozo = 2 × startingStack mientras la partida está en curso;
 *   - Σ (disponible + bloqueado) de todos los jugadores es constante;
 *   - bloqueado = startingStack × partidas abiertas de cada jugador;
 *   - una acción rechazada no cambia stateVersion ni fichas;
 *   - ninguna vista expone cartas del rival salvo un showdown terminado;
 *   - las 10 cartas en mano son distintas; cada showdown paga a la mano correcta (evaluador de referencia).
 *
 *   FUZZ_HANDS=1500 FUZZ_SEED=7 npx vitest run -c test/audit/vitest.config.ts test/audit/apiFuzz.audit.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Hand, Match } from "@prisma/client";
import { buildServer } from "../../src/api/server.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/infrastructure/prisma/client.js";
import { parseCard } from "../../src/domain/card.js";
import { blockedMismatches, cmd, bearer, expireCurrentTurn, makePlayer, totalChips, type AuditPlayer } from "../helpers/scenario.js";
import { compareScores, mulberry32, pick, randInt, referenceScore } from "./reference.js";

const HANDS = Number(process.env.FUZZ_HANDS ?? 150);
const SEED = Number(process.env.FUZZ_SEED ?? 20261009);

let app: FastifyInstance;
beforeAll(async () => {
  await resetDatabase();
  // Sin límites de tasa: el fuzz hace miles de peticiones por minuto desde una sola IP.
  app = await buildServer({ logger: false, rateLimit: false });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

type Body = Record<string, unknown>;

/** Vitest no muestra la consola de los tests que pasan: con FUZZ_STATS_FILE el progreso queda en un fichero. */
function report(line: string) {
  console.info(line);
  if (process.env.FUZZ_STATS_FILE) appendFileSync(process.env.FUZZ_STATS_FILE, `${new Date().toISOString()} ${line}\n`);
}

type InjectOpts = { method: "GET" | "POST"; url: string; headers?: Record<string, string>; payload?: unknown };
function inject(o: InjectOpts) {
  return app.inject({ ...o, payload: o.payload as Body, headers: o.headers ?? {} });
}

async function dbState(matchId: string): Promise<{ match: Match; hand: Hand | null }> {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const hand =
    match.handNumber > 0
      ? await prisma.hand.findUnique({ where: { matchId_number: { matchId, number: match.handNumber } } })
      : null;
  return { match, hand };
}

describe("fuzz de la API con invariantes", () => {
  it(`${HANDS} manos aleatorias (semilla ${SEED}) sin violar invariantes`, async () => {
    const rnd = mulberry32(SEED);
    const violations: string[] = [];
    const stats = { legal: 0, illegal: 0, replays: 0, timeouts: 0, resigns: 0, showdowns: 0, splits: 0, folds: 0, matches: 0 };
    const fail = (msg: string) => {
      if (violations.length < 25) violations.push(msg);
    };

    const players: AuditPlayer[] = await Promise.all([0, 1, 2].map((i) => makePlayer(`fz${i}`, 5_000_000)));
    const outsider = players[2]!;
    const chips0 = await totalChips();
    const seenHands = new Set<string>();
    let handsPlayed = 0;
    const startedAt = Date.now();

    async function checkGlobal(ctx: string) {
      const chips = await totalChips();
      if (chips !== chips0) fail(`Σ fichas ${chips} ≠ ${chips0} tras ${ctx}`);
      const blocked = await blockedMismatches();
      if (blocked.length) fail(`reserva incoherente tras ${ctx}: ${blocked.join("; ")}`);
    }

    async function checkMatch(matchId: string, a: AuditPlayer, b: AuditPlayer, ctx: string) {
      const { match, hand } = await dbState(matchId);
      if (match.status === "IN_PROGRESS" && hand) {
        const pot = hand.player1Contribution + hand.player2Contribution;
        const total = match.player1Stack! + match.player2Stack! + pot;
        if (total !== 2 * match.startingStack) fail(`mesa ${total} ≠ ${2 * match.startingStack} tras ${ctx}`);
        if (match.player1Stack! < 0 || match.player2Stack! < 0) fail(`stack negativo tras ${ctx}`);
        const cards = [...(hand.player1Cards as string[]), ...(hand.player2Cards as string[])];
        if (new Set(cards).size !== 10) fail(`cartas repetidas ${cards} tras ${ctx}`);
        if (hand.toActPlayerId) {
          const slot = hand.toActPlayerId === match.player1Id ? "player1" : "player2";
          if (hand.phase !== "DRAW" && hand[`${slot}AllIn`]) fail(`turno de apuesta a un jugador all-in (${hand.phase}) tras ${ctx}`);
          if (!hand.turnExpiresAt) fail(`turno sin vencimiento tras ${ctx}`);
        }
      }
      if (match.status === "MATCH_FINISHED" && match.player1Stack! + match.player2Stack! !== 2 * match.startingStack) {
        fail(`stacks finales ${match.player1Stack}+${match.player2Stack} tras ${ctx}`);
      }
      // Manos recién terminadas: el pago coincide con el evaluador de referencia.
      const finished = await prisma.hand.findMany({ where: { matchId, phase: "HAND_FINISHED" } });
      for (const h of finished) {
        if (seenHands.has(h.id)) continue;
        seenHands.add(h.id);
        handsPlayed += 1;
        const pot = h.player1Contribution + h.player2Contribution;
        if ((h.payoutPlayer1 ?? 0) + (h.payoutPlayer2 ?? 0) !== pot) fail(`pago ≠ pozo en mano ${h.number} (${ctx})`);
        if (h.winReason === "FOLD") stats.folds += 1;
        if (h.winReason === "SHOWDOWN" || h.winReason === "SPLIT") {
          const s1 = referenceScore((h.player1Cards as string[]).map(parseCard));
          const s2 = referenceScore((h.player2Cards as string[]).map(parseCard));
          const c = compareScores(s1, s2);
          const want = c > 0 ? match.player1Id : c < 0 ? match.player2Id : null;
          if (h.winnerId !== want) fail(`ganador incorrecto en mano ${h.number}: ${h.winnerId} ≠ ${want}`);
          if (c === 0) {
            stats.splits += 1;
            const buttonIs1 = h.dealerPlayerId === match.player1Id;
            const odd = pot % 2;
            const want1 = Math.floor(pot / 2) + (buttonIs1 ? odd : 0);
            if (h.payoutPlayer1 !== want1) fail(`reparto de empate incorrecto en mano ${h.number}`);
          } else stats.showdowns += 1;
          if (!h.revealedCards) fail(`showdown sin cartas reveladas en mano ${h.number}`);
        }
      }
      // Vistas: cada uno ve solo lo suyo.
      for (const [me, other] of [[a, b], [b, a]] as const) {
        const res = await inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: bearer(me) });
        if (res.statusCode !== 200) {
          fail(`GET ${res.statusCode} tras ${ctx}`);
          continue;
        }
        const v = res.json();
        const fresh = await dbState(matchId);
        const mySlot = fresh.match.player1Id === me.id ? "player1" : "player2";
        const otherSlot = mySlot === "player1" ? "player2" : "player1";
        if (fresh.hand) {
          if (JSON.stringify(v.you.cards) !== JSON.stringify(fresh.hand[`${mySlot}Cards`])) fail(`mis cartas no coinciden tras ${ctx}`);
          const showdownOver = fresh.hand.phase === "HAND_FINISHED" && fresh.hand.winReason !== "FOLD" && fresh.hand.revealedCards;
          if (v.opponent?.cards && !showdownOver) fail(`la vista de ${me.displayName} expone cartas de ${other.displayName} tras ${ctx}`);
          // lastHand puede traer, legítimamente, las cartas de un showdown ANTERIOR: se revisa aparte.
          const { lastHand, ...current } = v;
          if (lastHand?.revealedCards && lastHand.winReason !== "SHOWDOWN" && lastHand.winReason !== "SPLIT") {
            fail(`lastHand con cartas reveladas sin showdown (${lastHand.winReason}) tras ${ctx}`);
          }
          const raw = JSON.stringify(current);
          if (!showdownOver) {
            for (const card of fresh.hand[`${otherSlot}Cards`] as string[]) {
              if (!(fresh.hand[`${mySlot}Cards`] as string[]).includes(card) && raw.includes(`"${card}"`)) {
                fail(`carta rival ${card} aparece en la vista tras ${ctx}`);
              }
            }
          }
          if (raw.includes(fresh.hand.deckSeed)) fail(`semilla de la mano en curso en la vista tras ${ctx}`);
        }
      }
      await checkGlobal(ctx);
    }

    function legalBodies(v: { legalActions: Array<Record<string, number | string>>; stateVersion: number }): Body[] {
      const out: Body[] = [];
      for (const a of v.legalActions) {
        if (a.type === "CHECK") out.push({ type: "BET", amount: 0 });
        if (a.type === "CALL") out.push({ type: "BET", amount: a.amount });
        if (a.type === "RAISE") {
          const min = a.min as number;
          const max = a.max as number;
          out.push({ type: "BET", amount: min }, { type: "BET", amount: randInt(rnd, min, max) });
        }
        if (a.type === "ALL_IN") out.push({ type: "ALL_IN" });
        if (a.type === "FOLD" && rnd() < 0.5) out.push({ type: "FOLD" });
        if (a.type === "DRAW") {
          const idx = [0, 1, 2, 3, 4].filter(() => rnd() < 0.4);
          out.push({ type: "DRAW", discardedIndexes: idx });
        }
      }
      return out.map((b) => ({ ...b, actionVersion: v.stateVersion }));
    }

    function illegalBodies(v: { stateVersion: number; phase: string; legalActions: Array<Record<string, number | string>> }): Body[] {
      const ver = v.stateVersion;
      const raise = v.legalActions.find((a) => a.type === "RAISE");
      const call = v.legalActions.find((a) => a.type === "CALL");
      const bodies: Body[] = [
        { type: "BET", amount: 20, actionVersion: ver - 1 },
        { type: "BET", amount: -20, actionVersion: ver },
        { type: "BET", amount: 20.5, actionVersion: ver },
        { type: "BET", amount: 1e12, actionVersion: ver },
        { type: "BET", amount: "20", actionVersion: ver },
        { type: "BET", actionVersion: ver },
        { type: "CHECK", actionVersion: ver },
        { type: "DRAW", discardedIndexes: [1, 1], actionVersion: ver },
        { type: "DRAW", discardedIndexes: [5], actionVersion: ver },
        { type: "DRAW", discardedIndexes: [0, 1, 2, 3, 4, 0], actionVersion: ver },
        { type: "DRAW", discardedIndexes: [-1], actionVersion: ver },
        { type: "DRAW", discardedIndexes: [0.5], actionVersion: ver },
        { type: "FOLD", actionVersion: "x" },
      ];
      if (v.phase === "DRAW") bodies.push({ type: "BET", amount: 0, actionVersion: ver }, { type: "FOLD", actionVersion: ver });
      if (v.phase !== "DRAW") bodies.push({ type: "DRAW", discardedIndexes: [], actionVersion: ver });
      if (raise) bodies.push({ type: "BET", amount: (raise.min as number) - 1, actionVersion: ver });
      if (call) bodies.push({ type: "BET", amount: 0, actionVersion: ver }, { type: "BET", amount: (call.amount as number) - 1, actionVersion: ver });
      return bodies;
    }

    while (handsPlayed < HANDS) {
      // Partida nueva entre fz0 y fz1 con reglas al azar (stacks cortos → más all-in y finales de partida).
      const [a, b] = rnd() < 0.5 ? [players[0]!, players[1]!] : [players[1]!, players[0]!];
      const bb = pick(rnd, [2, 4, 10, 20, 50]);
      const sb = randInt(rnd, 1, bb - 1);
      const rules = { startingStack: Math.max(100, bb * randInt(rnd, 5, 25)), smallBlind: sb, bigBlind: bb, turnTimeoutSeconds: 120 };
      const created = await inject({ method: "POST", url: "/v1/matches", headers: cmd(a), payload: { ...rules, inviteeId: b.id } });
      if (created.statusCode !== 201) throw new Error(`create ${created.statusCode} ${created.body}`);
      const { id: matchId, joinToken } = created.json();
      await checkGlobal("crear");
      const joined = await inject({ method: "POST", url: `/v1/matches/${matchId}/join`, headers: cmd(b), payload: { joinToken } });
      if (joined.statusCode !== 200) throw new Error(`join ${joined.statusCode} ${joined.body}`);
      stats.matches += 1;
      await checkMatch(matchId, a, b, "unirse");

      let lastOk: { player: AuditPlayer; key: string; body: Body; response: string } | null = null;
      let handsAtLastProgress = handsPlayed;
      let stepsWithoutHand = 0;
      for (let step = 0; step < 400 && handsPlayed < HANDS; step++) {
        const { match, hand } = await dbState(matchId);
        if (match.status !== "IN_PROGRESS" || !hand?.toActPlayerId) break;
        // Una mano no puede quedarse sin terminar indefinidamente con ~60 % de acciones legales.
        if (handsPlayed !== handsAtLastProgress) {
          handsAtLastProgress = handsPlayed;
          stepsWithoutHand = 0;
        } else if (++stepsWithoutHand > 150) {
          fail(`mano ${hand.number} de ${matchId} sin terminar tras 150 pasos (fase ${hand.phase}, v${match.stateVersion})`);
          break;
        }
        if (step === 0 && stats.matches % 25 === 0) {
          report(`[fuzz] semilla ${SEED}: ${handsPlayed} manos en ${Math.round((Date.now() - startedAt) / 1000)} s, ${JSON.stringify(stats)}`);
        }
        const actor = hand.toActPlayerId === a.id ? a : b;
        const idle = actor === a ? b : a;
        const got = await inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: bearer(actor) });
        if (got.statusCode !== 200) {
          fail(`GET del jugador en turno → ${got.statusCode} ${got.body}`);
          break;
        }
        const v = got.json();
        const roll = rnd();
        const ctx = `paso ${step} de ${matchId} (${hand.phase}, roll ${roll.toFixed(3)})`;

        if (roll < 0.62) {
          const options = legalBodies(v);
          if (!options.length) {
            fail(`sin acciones legales para quien tiene el turno: ${ctx}`);
            break;
          }
          const body = pick(rnd, options);
          const key = randomUUID();
          const res = await inject({ method: "POST", url: `/v1/matches/${matchId}/actions`, headers: cmd(actor, key), payload: body });
          stats.legal += 1;
          if (res.statusCode !== 200) fail(`acción legal ${JSON.stringify(body)} rechazada ${res.statusCode} ${res.body} (${ctx})`);
          else lastOk = { player: actor, key, body, response: res.body };
        } else if (roll < 0.84) {
          const before = await dbState(matchId);
          const who = rnd() < 0.15 ? idle : rnd() < 0.05 ? outsider : actor;
          const body = pick(rnd, who === actor ? illegalBodies(v) : legalBodies(v).concat(illegalBodies(v)));
          const headers = rnd() < 0.05 ? bearer(who) : cmd(who);
          const res = await inject({ method: "POST", url: `/v1/matches/${matchId}/actions`, headers, payload: body });
          stats.illegal += 1;
          if (res.statusCode < 400 || res.statusCode >= 500) fail(`ilegal ${JSON.stringify(body)} de ${who.displayName} → ${res.statusCode} ${res.body} (${ctx})`);
          if (res.statusCode >= 400 && !String(res.headers["content-type"]).includes("problem+json")) fail(`error sin problem+json (${ctx})`);
          if (res.body.includes("    at ")) fail(`stack trace en la respuesta (${ctx})`);
          const after = await dbState(matchId);
          if (after.match.stateVersion !== before.match.stateVersion || after.match.player1Stack !== before.match.player1Stack) {
            fail(`acción rechazada alteró el estado: ${JSON.stringify(body)} (${ctx})`);
          }
        } else if (roll < 0.9 && lastOk) {
          const before = await dbState(matchId);
          const same = await inject({
            method: "POST",
            url: `/v1/matches/${matchId}/actions`,
            headers: cmd(lastOk.player, lastOk.key),
            payload: lastOk.body,
          });
          stats.replays += 1;
          const replay = same.json();
          const original = JSON.parse(lastOk.response);
          if (same.statusCode !== 200 || !replay.idempotentReplay || replay.actionId !== original.actionId) {
            fail(`repetición idempotente incorrecta ${same.statusCode} ${same.body} (${ctx})`);
          }
          const conflict = await inject({
            method: "POST",
            url: `/v1/matches/${matchId}/actions`,
            headers: cmd(lastOk.player, lastOk.key),
            payload: { ...lastOk.body, actionVersion: (lastOk.body.actionVersion as number) + 1000 },
          });
          if (conflict.statusCode !== 409 || conflict.json().code !== "IDEMPOTENCY_CONFLICT") fail(`clave reusada con otro body → ${conflict.statusCode} (${ctx})`);
          const after = await dbState(matchId);
          if (after.match.stateVersion !== before.match.stateVersion) fail(`la repetición cambió el estado (${ctx})`);
        } else if (roll < 0.985) {
          await expireCurrentTurn(matchId);
          const res = await inject({ method: "GET", url: `/v1/matches/${matchId}`, headers: bearer(rnd() < 0.5 ? a : b) });
          stats.timeouts += 1;
          if (res.statusCode !== 200) fail(`GET con turno vencido → ${res.statusCode} (${ctx})`);
        } else {
          const quitter = rnd() < 0.5 ? a : b;
          const res = await inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: cmd(quitter) });
          stats.resigns += 1;
          if (res.statusCode !== 200) fail(`resign → ${res.statusCode} (${ctx})`);
        }
        await checkMatch(matchId, a, b, ctx);
      }

      // Cierre: lo que quede abierto se abandona; un segundo abandono no debe liquidar otra vez.
      for (let i = 0; i < 2; i++) {
        const res = await inject({ method: "POST", url: `/v1/matches/${matchId}/resign`, headers: cmd(rnd() < 0.5 ? a : b) });
        if (res.statusCode !== 200) fail(`resign final → ${res.statusCode}`);
        await checkMatch(matchId, a, b, `cierre ${i}`);
      }
    }

    report(`[fuzz] semilla ${SEED} FIN: ${handsPlayed} manos en ${Math.round((Date.now() - startedAt) / 1000)} s, ${JSON.stringify(stats)}, violaciones: ${violations.length}`);
    expect(violations).toEqual([]);
  }, Number(process.env.FUZZ_TIMEOUT_MS ?? Math.max(180_000, HANDS * 300)));
});
