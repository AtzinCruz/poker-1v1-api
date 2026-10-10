#!/usr/bin/env node
// Conciliación de saldos bloqueados (AUD-01). Antes de la corrección, liquidaciones concurrentes podían
// dejar `blockedBalance` descuadrado (fichas bloqueadas sin partida, o reservas perdidas). El bloqueado
// correcto de cada jugador es la suma de `startingStack` de sus partidas abiertas (esperando rival como
// creador, o en curso).
//
//   node scripts/reconcileBalances.mjs            → solo informa (no cambia nada)
//   node scripts/reconcileBalances.mjs --apply    → corrige, en una transacción
//
// Al corregir, la diferencia se mueve entre bloqueado y disponible: lo bloqueado de más vuelve al saldo
// disponible; lo bloqueado de menos se descuenta del disponible si alcanza (si no, se informa y ese
// jugador se deja como está para revisarlo a mano). Usa DATABASE_URL (o el .env).
import pg from "pg";

try {
  if (!process.env.DATABASE_URL) process.loadEnvFile();
} catch {
  // sin .env: DATABASE_URL tiene que venir del entorno
}
if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const url = new URL(process.env.DATABASE_URL);
for (const param of ["schema", "connection_limit", "pool_timeout"]) url.searchParams.delete(param);
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

const MISMATCHES = `
  SELECT p.id, p."displayName", p."fictionalBalance" AS available, p."blockedBalance" AS blocked,
         COALESCE(SUM(m."startingStack"), 0)::int AS expected
  FROM "Player" p
  LEFT JOIN "Match" m
    ON m.status IN ('WAITING_FOR_OPPONENT', 'IN_PROGRESS') AND (m."player1Id" = p.id OR m."player2Id" = p.id)
  GROUP BY p.id
  HAVING p."blockedBalance" <> COALESCE(SUM(m."startingStack"), 0)
  ORDER BY p."displayName"`;

try {
  await client.query("BEGIN");
  // Nadie liquida ni reserva mientras se concilia: la foto y la corrección son consistentes.
  if (APPLY) await client.query(`LOCK TABLE "Player", "Match" IN SHARE ROW EXCLUSIVE MODE`);
  const { rows } = await client.query(MISMATCHES);
  if (rows.length === 0) {
    console.log("Sin desajustes: el saldo bloqueado de cada jugador coincide con sus partidas abiertas.");
  }
  let fixed = 0;
  for (const row of rows) {
    const diff = row.blocked - row.expected; // > 0: bloqueado de más; < 0: de menos
    const line = `${row.displayName}: bloqueado ${row.blocked}, esperado ${row.expected} (${diff > 0 ? "+" : ""}${diff}), disponible ${row.available}`;
    if (!APPLY) {
      console.log(line);
      continue;
    }
    if (row.available + diff < 0) {
      console.log(`${line} → SIN CORREGIR: el disponible no alcanza para cubrir la reserva que falta`);
      continue;
    }
    await client.query(
      `UPDATE "Player" SET "blockedBalance" = $2, "fictionalBalance" = "fictionalBalance" + $3 WHERE id = $1`,
      [row.id, row.expected, diff],
    );
    fixed += 1;
    console.log(`${line} → corregido`);
  }
  await client.query(APPLY ? "COMMIT" : "ROLLBACK");
  if (APPLY) console.log(`${fixed} de ${rows.length} jugadores corregidos.`);
  else if (rows.length) console.log(`\n${rows.length} jugadores con desajuste. Vuelve a correrlo con --apply para corregirlos.`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
