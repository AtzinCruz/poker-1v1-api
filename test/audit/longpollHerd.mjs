// AUD-06 — Mide qué pasa cuando UN cliente abre N long-polls sobre su partida y todas despiertan a la vez.
// Requiere un servidor corriendo contra una BD desechable (crea jugadores y partidas), p. ej.:
//   DATABASE_URL=<bd de pruebas> PORT=3300 NODE_ENV=test TRUST_PROXY_HOPS=1 node --import tsx src/api/start.ts
//   node test/audit/longpollHerd.mjs http://localhost:3300 2000
// Usa una X-Forwarded-For distinta por petición (con TRUST_PROXY_HOPS=1 el script hace de proxy) para
// medir el tope de esperas y no el límite global por IP. Tras la corrección, solo MAX_WAITS_PER_MATCH (3)
// esperas quedan abiertas; las demás responden al instante y, si insisten, reciben 429 por partida.
const BASE = process.argv[2] ?? "http://localhost:3300";
const N = Number(process.argv[3] ?? 1000);
let ip = 1;
const xff = () => `10.9.${(ip >> 8) & 255}.${ip++ & 255}`;
async function post(path, body, token, extra = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": xff(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const get = async (path, token) => {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": xff() } });
  await res.text();
  return { status: res.status, ms: performance.now() - t0 };
};

const stamp = Date.now().toString(36);
const a = (await post("/v1/auth/session", { displayName: `herd-a-${stamp}`, password: "contraseña-herd-1" })).json;
const b = (await post("/v1/auth/session", { displayName: `herd-b-${stamp}`, password: "contraseña-herd-1" })).json;
const c = (await post("/v1/auth/session", { displayName: `herd-c-${stamp}`, password: "contraseña-herd-1" })).json;
const d = (await post("/v1/auth/session", { displayName: `herd-d-${stamp}`, password: "contraseña-herd-1" })).json;
const m = (await post("/v1/matches", { startingStack: 1000, smallBlind: 10, bigBlind: 20, turnTimeoutSeconds: 120, inviteeId: b.player.id }, a.token, { "idempotency-key": crypto.randomUUID() })).json;
await post(`/v1/matches/${m.id}/join`, { joinToken: m.joinToken }, b.token, { "idempotency-key": crypto.randomUUID() });
// Partida ajena, para medir cómo le afecta a otro usuario.
const m2 = (await post("/v1/matches", { startingStack: 1000, smallBlind: 10, bigBlind: 20, inviteeId: d.player.id }, c.token, { "idempotency-key": crypto.randomUUID() })).json;
await post(`/v1/matches/${m2.id}/join`, { joinToken: m2.joinToken }, d.token, { "idempotency-key": crypto.randomUUID() });

const view = await (await fetch(`${BASE}/v1/matches/${m.id}`, { headers: { authorization: `Bearer ${a.token}`, "x-forwarded-for": xff() } })).json();
const since = view.stateVersion;

const t0 = performance.now();
const polls = Array.from({ length: N }, () => get(`/v1/matches/${m.id}?since=${since}`, b.token));
await new Promise((r) => setTimeout(r, 3000)); // que todas queden esperando
const baseline = await get(`/v1/matches/${m2.id}`, c.token);

// El cambio que despierta a todas a la vez.
const actRes = await post(`/v1/matches/${m.id}/actions`, { type: "BET", amount: 20, actionVersion: since }, a.token, { "idempotency-key": crypto.randomUUID() });
const during = await Promise.all(Array.from({ length: 5 }, () => get(`/v1/matches/${m2.id}`, c.token)));
const results = await Promise.all(polls);
const codes = {};
for (const r of results) codes[r.status] = (codes[r.status] ?? 0) + 1;
const lat = results.map((r) => r.ms).sort((x, y) => x - y);
console.log(JSON.stringify({
  N,
  action: actRes.status,
  longPollCodes: codes,
  wallClockMs: Math.round(performance.now() - t0),
  otherUserBaselineMs: Math.round(baseline.ms),
  otherUserDuringHerdMs: during.map((x) => `${x.status}:${Math.round(x.ms)}`),
  slowestLongPollMs: Math.round(lat.at(-1)),
}));
