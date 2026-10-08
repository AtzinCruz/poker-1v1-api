#!/usr/bin/env node
// Prueba de carga de la ruta caliente: GET /v1/matches/:id (lo que cada cliente consulta en la mesa).
//
//   node scripts/loadtest.mjs [baseUrl]            → informe con 1, 16 y 64 conexiones
//   node scripts/loadtest.mjs [baseUrl] --budget   → una corrida con 16 conexiones; sale con 1 si
//                                                     no cumple el presupuesto (para CI)
//
// Correr contra un servidor apuntado a la BD de test, nunca a la de desarrollo: crea jugadores y partidas.
// Cada petición lleva su propia IP en X-Forwarded-For (el servidor confía en un salto) para que los
// límites de tasa por IP no distorsionen la medición.

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const BUDGET_MODE = process.argv.includes("--budget");
// Medido en un M1 con Postgres local tras los arreglos de la auditoría; holgura para CI compartido.
const BUDGET = { concurrency: 16, minRps: 400, maxP95Ms: 60 };
const DURATION_MS = Number(process.env.LOADTEST_DURATION_MS ?? 8000);
const PASSWORD = "contraseña-de-carga-123";

let ipCounter = 1;
const nextIp = () => {
  const n = ipCounter++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
const headers = (token, extra = {}) => ({
  "content-type": "application/json",
  "x-forwarded-for": nextIp(),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});

async function post(path, body, token, extra) {
  const res = await fetch(BASE + path, { method: "POST", headers: headers(token, extra), body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function setupSeats(matches) {
  const stamp = Date.now().toString(36);
  const seats = [];
  for (let i = 0; i < matches; i++) {
    const a = await post("/v1/auth/session", { displayName: `load-a${i}-${stamp}`, password: PASSWORD });
    const b = await post("/v1/auth/session", { displayName: `load-b${i}-${stamp}`, password: PASSWORD });
    const m = await post(
      "/v1/matches",
      { startingStack: 1000, smallBlind: 10, bigBlind: 20, turnTimeoutSeconds: 120, inviteeId: b.player.id },
      a.token,
      { "idempotency-key": crypto.randomUUID() },
    );
    await post(`/v1/matches/${m.id}/join`, { joinToken: m.joinToken }, b.token, { "idempotency-key": crypto.randomUUID() });
    seats.push({ id: m.id, token: a.token }, { id: m.id, token: b.token });
  }
  return seats;
}

async function run(seats, concurrency) {
  const latencies = [];
  const codes = {};
  let next = 0;
  const end = performance.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        const seat = seats[next++ % seats.length];
        const started = performance.now();
        const res = await fetch(`${BASE}/v1/matches/${seat.id}`, { headers: headers(seat.token) });
        await res.arrayBuffer();
        latencies.push(performance.now() - started);
        codes[res.status] = (codes[res.status] ?? 0) + 1;
      }
    }),
  );
  latencies.sort((x, y) => x - y);
  const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  return { concurrency, rps: latencies.length / (DURATION_MS / 1000), p50: at(0.5), p95: at(0.95), p99: at(0.99), codes };
}

const fmt = (r) =>
  `c=${String(r.concurrency).padStart(3)}  ${r.rps.toFixed(0).padStart(5)} req/s  ` +
  `p50=${r.p50.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms  p99=${r.p99.toFixed(1)}ms  ${JSON.stringify(r.codes)}`;

const seats = await setupSeats(20);
await run(seats, 4); // calentamiento (JIT, pool de conexiones)

if (BUDGET_MODE) {
  const r = await run(seats, BUDGET.concurrency);
  console.log(`GET /v1/matches/:id  ${fmt(r)}`);
  const errors = Object.entries(r.codes).filter(([code]) => code !== "200").reduce((n, [, c]) => n + c, 0);
  if (errors > 0 || r.rps < BUDGET.minRps || r.p95 > BUDGET.maxP95Ms) {
    console.error(`Fuera de presupuesto: mínimo ${BUDGET.minRps} req/s, p95 ≤ ${BUDGET.maxP95Ms} ms y 0 errores.`);
    process.exit(1);
  }
  console.log("Dentro del presupuesto.");
} else {
  for (const c of [1, 16, 64]) console.log(`GET /v1/matches/:id  ${fmt(await run(seats, c))}`);
}
