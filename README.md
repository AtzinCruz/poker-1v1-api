# Póker Five-Card Draw 1 vs. 1

Implementación completa (motor de juego + API REST + cliente web jugable) de la especificación
`Especificacion_Poker_1v1_API.pdf` (v1.0). El servidor es autoritativo: reparte, valida cada
acción, calcula el pozo y liquida las fichas; el cliente solo muestra el estado permitido y envía
intenciones de juego.

## Alcance de esta entrega

- ✅ Motor de juego completo (mazo, evaluación de manos, motor de apuestas heads-up, máquina de
  estados de 8 fases, timeouts de turno).
- ✅ API REST completa (sección 6 del spec) con idempotencia, control de concurrencia optimista
  (`actionVersion`/`stateVersion`), errores `problem+json` y auditoría de manos.
- ✅ Economía ficticia aislada (saldo disponible/bloqueado por jugador).
- ✅ **Cliente web jugable** (`public/`): sin build step, servido por el mismo servidor Fastify en
  `http://localhost:3000`. Login, lobby (crear/unirse/reanudar partida), mesa con cartas, apuestas,
  draw y showdown, todo por polling sobre la API REST (ver detalle abajo).
- ❌ Canal WebSocket (sección 7) — queda para una siguiente iteración; el cliente actual usa
  polling (`GET /matches/{id}` cada 1.5s) en su lugar. El log de eventos (`GameEvent`) ya está
  pensado para alimentar el WebSocket después sin cambiar el resto del modelo.
- ⚠️ Identidad: el spec asume un módulo de identidad externo que emite JWT. Como stub de
  desarrollo, `POST /v1/auth/dev-session` crea el jugador (si no existe) y firma un JWT. **No es
  un sistema de autenticación real** — reemplázalo por tu IdP antes de exponer esto fuera de un
  entorno de desarrollo.

## Stack

- Backend: Node.js + TypeScript, Fastify.
- Frontend: HTML/CSS/JS vanilla (sin framework ni bundler), servido como estático por el mismo
  Fastify (`@fastify/static`) — un solo proceso, sin CORS.
- PostgreSQL + Prisma (migraciones en `prisma/migrations`).
- Zod para validar los cuerpos de solicitud.
- Vitest para tests unitarios (motor de juego) y de integración (API completa contra Postgres).

## Requisitos

- Node.js 20+
- Docker (para levantar Postgres con `docker-compose.yml`)

## Puesta en marcha

```bash
cd poker-1v1-api
npm install
cp .env.example .env        # ajusta si hace falta
docker compose up -d        # Postgres en localhost:5433 (dev + test)
npm run prisma:migrate      # aplica las migraciones a la base de dev
npm run dev                 # http://localhost:3000
```

> El `docker-compose.yml` expone Postgres en el puerto **5433** del host (no 5432), para no
> chocar con otros proyectos que ya usan el puerto por defecto.

Para dejar la base de test también migrada (la usan `npm run test:integration`):

```bash
DATABASE_URL="postgresql://poker:poker@localhost:5433/poker_test?schema=public" npx prisma migrate deploy
```

## Jugar desde el navegador

Con el servidor corriendo (`npm run dev`), abrí **http://localhost:3000** — ahí está el cliente
web. Para jugar una partida 1 vs. 1 necesitás dos sesiones de navegador independientes (dos
pestañas normales alcanza, porque la sesión se guarda en `sessionStorage`, que es por pestaña; no
sirve abrir dos pestañas en modo incógnito compartido, pero sí dos ventanas o dos perfiles):

1. **Pestaña 1**: escribí un nombre y entrá. En el lobby vas a ver tu "ID de jugador" — copialo.
2. **Pestaña 2**: entrá con otro nombre. Copiá este segundo ID también.
3. En la **pestaña 1**, pegá el ID de la pestaña 2 en "Crear partida" y creá la partida. Vas a
   quedar en una mesa esperando, con el ID de partida y el token de invitación a la vista.
4. En la **pestaña 2**, pegá esos dos datos en "Unirme a una partida" y confirmá — la primera
   mano se reparte automáticamente apenas se unen los dos.
5. Jugá turno a turno: cada pestaña muestra sus propias cartas, el pozo, de quién es el turno (con
   cuenta regresiva) y los botones de acción que correspondan (Check/Call/Raise/All-in/Fold, o la
   selección de cartas a descartar en la fase de draw).

Si recargás la página a mitad de partida, el cliente recuerda la última partida activa (guardada
en `sessionStorage`) y vuelve a conectarse solo; si no, podés pegar el ID de partida en "Reanudar
partida" desde el lobby.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor con recarga en caliente (`tsx watch`). |
| `npm run build` / `npm start` | Compila a `dist/` y lo corre con Node. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint sobre `src` y `test`. |
| `npm test` | Unitarios + integración (requiere Postgres corriendo). |
| `npm run test:unit` | Solo el motor de juego, sin base de datos. |
| `npm run test:integration` | Solo la API completa contra `poker_test`. |

## Sesión de ejemplo con curl

```bash
# 1. Dos jugadores "inician sesión" (stub de identidad)
ALICE=$(curl -s -X POST localhost:3000/v1/auth/dev-session -d '{"displayName":"alice"}' -H 'Content-Type: application/json')
BOB=$(curl -s -X POST localhost:3000/v1/auth/dev-session -d '{"displayName":"bob"}' -H 'Content-Type: application/json')
ALICE_TOKEN=$(echo $ALICE | jq -r .token)
BOB_TOKEN=$(echo $BOB | jq -r .token)
BOB_ID=$(echo $BOB | jq -r .player.id)

# 2. Alice crea una partida invitando a Bob
MATCH=$(curl -s -X POST localhost:3000/v1/matches \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d "{\"startingStack\":1000,\"smallBlind\":10,\"bigBlind\":20,\"inviteeId\":\"$BOB_ID\"}")
MATCH_ID=$(echo $MATCH | jq -r .id)
JOIN_TOKEN=$(echo $MATCH | jq -r .joinToken)

# 3. Bob se une (esto reparte automáticamente la primera mano)
curl -s -X POST localhost:3000/v1/matches/$MATCH_ID/join \
  -H "Authorization: Bearer $BOB_TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d "{\"joinToken\":\"$JOIN_TOKEN\"}"

# 4. Cada jugador consulta su vista filtrada (solo ve sus propias cartas)
curl -s localhost:3000/v1/matches/$MATCH_ID -H "Authorization: Bearer $ALICE_TOKEN" | jq .

# 5. Alice (botón/ciega chica) iguala la ciega grande — usa el stateVersion de la respuesta anterior
curl -s -X POST localhost:3000/v1/matches/$MATCH_ID/actions \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{"type":"BET","amount":20,"actionVersion":3}'
```

El resto de la mano (draw, ronda final de apuestas, showdown) sigue el mismo patrón:
`GET /v1/matches/{id}` para ver de quién es el turno y qué `stateVersion`/`legalActions` hay
disponibles, y `POST /v1/matches/{id}/actions` con el `actionVersion` correspondiente.

## Decisiones de diseño relevantes

- **Orden de turno**: el botón actúa primero tanto en la ronda pre-draw como en la post-draw, y
  también dibuja primero en la fase DRAW — así lo indica explícitamente la sección 2.2 del spec,
  aunque difiera de la convención heads-up habitual.
- **Timeouts sin WebSocket**: como esta entrega no empuja eventos, un turno vencido se resuelve
  de forma perezosa en cuanto llega la siguiente lectura o acción sobre esa partida (`GET` o
  `POST .../actions`), aplicando la regla automática de la sección 2.4 (draw vacío / check si se
  puede / fold en otro caso).
- **All-in con solo un jugador activo**: si el botón (o el rival) ya está all-in al empezar una
  ronda de apuestas, esa ronda arranca directamente con quien todavía puede decidir; si ambos ya
  están all-in, la ronda se salta por completo y se va derecho a showdown — pero la fase DRAW
  nunca se salta, ambos jugadores siguen pudiendo descartar.
- **Economía ficticia**: al crear o unirse a una partida se reserva `startingStack` del saldo
  disponible del jugador (`blockedBalance`); al terminar la partida (por el motivo que sea) se
  libera la reserva y se acredita el stack final resultante.

## Reglas de terminación, seguridad y operación

- **Abandono (`resign`)**: cierra la mano en curso y el rival recibe todo el saldo en juego —su stack,
  el del que abandona y el pozo (spec §6/§9: "el rival gana el saldo en juego"). Las fichas se
  conservan: lo que entra a la partida es exactamente lo que se reparte al terminar.
- **Eliminación**: una mano nueva solo empieza si *ambos* jugadores cubren la ciega grande (spec
  §2.1/§9, "la ciega grande requerida para participar"). Si no, gana quien sí puede.
- **Desconexión**: tras 3 acciones automáticas seguidas de un mismo jugador (sin que él actúe en
  medio) la partida termina con `DISCONNECT_TIMEOUT` y pierde el saldo en juego, como en un abandono
  (`DISCONNECT_AFTER_AUTO_ACTIONS` en `src/application/timeouts.ts`). Un barrido cada 15 s
  (`src/application/maintenance.ts`) aplica los timeouts aunque nadie consulte la partida, y cancela
  invitaciones sin aceptar tras 24 h liberando la reserva del creador.
- **Concurrencia**: todo lo que puede mutar una partida (comandos, `GET /matches/:id` que resuelve
  timeouts, `resign`, barrido) toma `SELECT … FOR UPDATE` sobre la fila de `Match`. `stateVersion`
  sube con *cada* cambio de estado (apuesta, check, draw, reparto), así que `actionVersion` protege
  también dentro de una mano.
- **Idempotencia**: la `Idempotency-Key` queda atada a la operación y a la partida; reusarla en otra
  responde `409 IDEMPOTENCY_CONFLICT`.
- **Tokens**: los de jugador llevan `aud: "player"` y los de admin `aud: "admin"`, ambos HS256. El de
  admin se firma con una clave derivada de `JWT_SECRET` **y** `ADMIN_SECRET`: conocer solo
  `JWT_SECRET` no alcanza para fabricarlo. Con `NODE_ENV=production` el servidor no arranca si
  `JWT_SECRET` es el valor por defecto o tiene menos de 32 caracteres (ni `ADMIN_SECRET` < 16).
  `POST /v1/auth/admin-session` admite 5 intentos por minuto por IP.
- **Auditoría**: cada ajuste de saldo del panel de admin queda en la tabla `AdminAction`
  (quién, a quién, monto, saldo antes y después); el saldo no puede superar 2 000 000 000.
- **Límites**: `bigBlind × 5 ≤ startingStack` al crear la partida.
- ⚠️ `POST /v1/auth/dev-session` sigue siendo el stub de identidad: **cualquiera puede entrar con
  cualquier nombre ya existente**. Es aceptable para una demo, no para un despliegue real.
