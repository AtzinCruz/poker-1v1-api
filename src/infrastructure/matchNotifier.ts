import { EventEmitter } from "node:events";
import pg from "pg";
import type { Prisma } from "@prisma/client";
import { config } from "../config.js";

/**
 * Avisos de "esta partida cambió" entre instancias, con LISTEN/NOTIFY de Postgres. Alimenta el
 * long-poll de GET /v1/matches/:id?since=N: en vez de que cada cliente consulte cada 1.5 s, la
 * petición espera hasta que la partida cambie.
 *
 * - Se notifica DENTRO de la transacción que cambia la partida: Postgres entrega el aviso solo al
 *   hacer COMMIT, así que nadie se despierta por un cambio que se revirtió ni antes de poder verlo.
 * - Una sola conexión LISTEN por proceso (no por instancia de Fastify). Requiere conexión directa a
 *   Postgres: PgBouncer en modo transacción no soporta LISTEN.
 * - Si la conexión se cae, se despierta a todos los que esperan (vuelven a leer y no se pierden
 *   cambios) y la siguiente espera reconecta. Sin listener, las esperas igual terminan por timeout.
 */

const CHANNEL = "match_changed";
const WAKE_ALL = Symbol("wake-all");
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let closed = false;

export async function notifyMatchChanged(tx: Prisma.TransactionClient, matchId: string): Promise<void> {
  // $executeRaw y no $queryRaw: pg_notify devuelve `void`, que Prisma no sabe deserializar.
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL}, ${matchId})`;
}

function connectionString(): string {
  const url = new URL(config.databaseUrl);
  // Parámetros propios de Prisma que `pg` no entiende.
  for (const param of ["schema", "connection_limit", "pool_timeout"]) url.searchParams.delete(param);
  return url.toString();
}

/** Abre (una vez) la conexión LISTEN. Idempotente y segura ante llamadas concurrentes. */
export function ensureMatchListener(): Promise<void> {
  if (closed || client) return Promise.resolve();
  connecting ??= (async () => {
    const next = new pg.Client({ connectionString: connectionString() });
    const drop = () => {
      if (client === next) client = null;
      next.removeAllListeners();
      next.end().catch(() => {});
      emitter.emit(WAKE_ALL); // pudo perderse un aviso: que todos vuelvan a leer
    };
    next.on("notification", (msg) => {
      if (msg.channel === CHANNEL && msg.payload) emitter.emit(msg.payload);
    });
    next.on("error", drop);
    next.on("end", drop);
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      client = next;
    } catch {
      next.removeAllListeners();
      await next.end().catch(() => {});
      // Sin listener el long-poll se degrada a esperar el timeout: funciona, solo más lento.
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export interface MatchChangeWait {
  /** Resuelve con true si llegó un aviso (o hay que releer), false si venció el plazo. */
  changed: Promise<boolean>;
  cancel: () => void;
}

/**
 * Se suscribe YA (antes de leer el estado) y devuelve la espera: si la partida cambia entre la
 * lectura y el `await`, el aviso no se pierde. Siempre llamar a `cancel` o esperar `changed`.
 */
export function subscribeToMatch(matchId: string, timeoutMs: number): MatchChangeWait {
  let finish!: (changed: boolean) => void;
  const changed = new Promise<boolean>((resolve) => (finish = resolve));
  const onChange = () => done(true);
  const timer = setTimeout(() => done(false), timeoutMs);
  function done(result: boolean) {
    clearTimeout(timer);
    emitter.off(matchId, onChange);
    emitter.off(WAKE_ALL, onChange);
    finish(result);
  }
  emitter.on(matchId, onChange);
  emitter.on(WAKE_ALL, onChange);
  if (closed) done(true);
  return { changed, cancel: () => done(false) };
}

/**
 * Despierta todas las esperas en curso: cada una vuelve a leer y responde. Para el cierre de una
 * instancia de Fastify (preClose), que si no esperaría hasta 25 s por cada long-poll abierto.
 */
export function wakeAllWaiters(): void {
  emitter.emit(WAKE_ALL);
}

/** Apagado del proceso: despierta las esperas y cierra la conexión LISTEN para siempre. */
export async function closeMatchListener(): Promise<void> {
  closed = true;
  wakeAllWaiters();
  const current = client;
  client = null;
  if (current) {
    current.removeAllListeners();
    await current.end().catch(() => {});
  }
}
