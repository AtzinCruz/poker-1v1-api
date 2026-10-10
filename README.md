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
  draw y showdown, todo sobre la API REST con long-polling (ver detalle abajo). **Hasta 4 partidas a
  la vez**, en pantalla dividida (2 × 2 en escritorio, apiladas en el móvil).
- ❌ Canal WebSocket (sección 7) — queda para una siguiente iteración. En su lugar, el cliente
  usa long-polling: `GET /v1/matches/{id}?since=<stateVersion>` queda abierto hasta que la partida
  cambia (aviso por `LISTEN/NOTIFY` de Postgres), vence el turno o pasan 25 s. Requiere conexión
  directa a Postgres (PgBouncer en modo transacción no soporta `LISTEN`); sin ella, cada espera
  termina por timeout y todo sigue funcionando, solo más lento.
- ⚠️ Identidad: el spec asume un módulo de identidad externo que emite JWT. Como stub de
  desarrollo, `POST /v1/auth/session` (nombre + contraseña) crea el jugador si no existe y firma un
  JWT de 1 hora que el cliente renueva solo (`POST /v1/auth/refresh`). Las contraseñas se guardan con
  scrypt y el login admite 10 intentos por minuto por IP y 10 por cuenta. **No es un sistema de identidad real** (sin correo ni recuperación de contraseña: un admin la restablece) — reemplázalo por tu IdP antes de exponer esto fuera de un
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

Si recargás la página a mitad de partida, el cliente recuerda las mesas abiertas (en
`sessionStorage`) y vuelve a conectarse solo; desde el lobby, "Tus partidas" lista las partidas sin
terminar para abrirlas en una mesa.

### Varias mesas

Se pueden jugar hasta **4 partidas a la vez**. "Otra mesa" lleva al lobby sin cerrar las abiertas: ahí
se crea o acepta otra partida, o se abre una de "Tus partidas", y aparece junto a las demás. Cada mesa
tiene su propio turno, cuenta regresiva, acciones y resultado de la mano; la que espera tu jugada se
resalta y la barra superior dice en cuántas te toca. "Cerrar" quita la mesa de la pantalla sin abandonar
la partida (el turno sigue corriendo); "Abandonar" sí la termina.

### Opciones al crear una partida

- **Fichas** (stack inicial de cada jugador): 300 por defecto (100 a 100 000).
- **Ciegas**: 10/20 por defecto (§2.1). La grande no puede superar el stack inicial.
- **Ciegas que suben**: cada 3 manos, las dos ciegas suben lo mismo, el 5 % del stack inicial
  redondeado hacia abajo. Con 300 fichas: 10/20 en las manos 1-3, 25/35 en las 4-6, 40/50 en las 7-9…
  La mesa muestra las ciegas vigentes y en qué mano suben. La revancha copia también esta opción.

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
| `npm run test:coverage` | Toda la suite con cobertura de `src/`; falla si baja de los mínimos de `vitest.config.ts`. |
| `npm run test:e2e` | Playwright (escritorio y móvil) contra la API real y `poker_test`; levanta el servidor solo. Primera vez: `npx playwright install chromium`. |
| `npm run loadtest -- <url> [--budget]` | Carga sobre `GET /v1/matches/:id` contra un servidor apuntado a `poker_test` y arrancado con `RATE_LIMIT_DISABLED=true`; con `--budget` falla si no cumple el presupuesto (lo usa CI). |
| `npm run test:audit` | Pruebas largas de la auditoría: fuzz de la API con invariantes y propiedades del motor (`FUZZ_HANDS=1000 FUZZ_SEED=7` para corridas largas). |
| `npm run reconcile [-- --apply]` | Concilia `blockedBalance` con las partidas abiertas de cada jugador (datos dañados antes de AUD-01); sin `--apply` solo informa. |

## Sesión de ejemplo con curl

```bash
# 1. Dos jugadores "inician sesión" (stub de identidad)
ALICE=$(curl -s -X POST localhost:3000/v1/auth/session -d '{"displayName":"alice","password":"contraseña-de-alice"}' -H 'Content-Type: application/json')
BOB=$(curl -s -X POST localhost:3000/v1/auth/session -d '{"displayName":"bob","password":"contraseña-de-bob-1"}' -H 'Content-Type: application/json')
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
- **All-in**: si alguno queda all-in en la ronda pre-draw, después del draw se va directo a showdown,
  sin ronda post-draw (§2.3 "no hay más apuestas posteriores", §9). Al cerrar la ronda las aportaciones
  ya quedaron igualadas (o se devolvió el excedente, y quien lo recupera deja de figurar all-in), así
  que no queda ninguna decisión de apuesta. La fase DRAW nunca se salta: ambos siguen pudiendo
  descartar, y cada uno ve cuántas cartas cambió el otro.
- **Semilla y compromiso**: `deckCommitment` (sha256 de la semilla) se publica en la vista desde el
  reparto; la semilla de cada mano se revela al **terminar la partida** (auditoría de la mano), no al
  terminar la mano. Con la semilla y los descartes se rearman las dos manos finales, también la que se
  retiró sin mostrarse: publicarla mano a mano dejaba perfilar al rival durante la sesión. Es una
  desviación consciente del §4.1/criterio 16, que piden revelarla al concluir la mano pero también que
  solo el showdown revele ambas manos (los dos requisitos chocan).
- **Economía ficticia**: al crear o unirse a una partida se reserva `startingStack` del saldo
  disponible del jugador (`blockedBalance`); al terminar la partida (por el motivo que sea) se
  libera la reserva y se acredita el stack final resultante.

## Reglas de terminación, seguridad y operación

- **Abandono (`resign`)**: quien abandona pierde la partida pero **se va con las fichas que le quedan**;
  lo que ya había puesto en la mano en curso es para el rival, como si se retirara. Decisión de producto
  que reemplaza la regla del spec (§6/§9: "el rival recibe el saldo en juego de la sesión"). Las fichas
  se conservan: lo que entra a la partida es exactamente lo que se reparte al terminar.
- **Eliminación**: una mano nueva solo empieza si *ambos* jugadores cubren la ciega grande (spec
  §2.1/§9, "la ciega grande requerida para participar"). Si no, gana quien sí puede.
- **Desconexión** (extensión al spec, que solo pide aplicar la regla de timeout): tras ~3 minutos de
  silencio de un jugador (acciones automáticas seguidas sin que él actúe en medio: 3 con turnos de
  60 s, 12 con turnos de 15 s; `disconnectThreshold` en `src/application/timeouts.ts`) la partida
  termina con `DISCONNECT_TIMEOUT`, igual que un abandono: se va con su stack y pierde lo apostado en
  la mano en curso. Sin esto, una partida sin ninguno de los dos jugadores no terminaría nunca y sus
  reservas quedarían bloqueadas. Un barrido cada 15 s
  (`src/application/maintenance.ts`) aplica los timeouts aunque nadie consulte la partida, y cancela
  invitaciones sin aceptar tras 24 h liberando la reserva del creador.
- **Concurrencia**: todo lo que puede mutar una partida (comandos, `resign`, barrido, y el
  `GET /matches/:id` *cuando hay un turno vencido que resolver*) toma `SELECT … FOR UPDATE` sobre la
  fila de `Match`; el resto de los polls leen con un snapshot sin bloquear. `stateVersion`
  sube con *cada* cambio de estado (apuesta, check, draw, reparto), así que `actionVersion` protege
  también dentro de una mano.
- **Saldos**: todo cambio de saldo es un incremento atómico (nunca "leer y escribir el valor
  calculado") y la BD rechaza saldos y stacks negativos (`CHECK`). Antes, liquidaciones concurrentes
  del mismo jugador podían crear o destruir fichas (AUD-01); `npm run reconcile` revisa datos viejos.
- **Orden de locks**: clave de idempotencia → partidas (la original antes que su revancha) →
  jugadores por id ascendente, todos de una vez (`src/application/locks.ts`). Así dos transacciones
  nunca se esperan en círculo; si aun así Postgres aborta una por deadlock, se reintenta entera y, si
  se agotan los intentos, la API responde `503` con `Retry-After`, no `500`.
- **Idempotencia**: la `Idempotency-Key` queda atada a la operación y a la partida; reusarla en otra
  responde `409 IDEMPOTENCY_CONFLICT`, también si las dos peticiones llegan a la vez (la clave se
  reserva antes de ejecutar nada). Cada `Action` guarda su clave y el estado posterior (`stateAfter`).
- **Tokens**: los de jugador llevan `aud: "player"` y los de admin `aud: "admin"`, ambos HS256. El de
  admin se firma con una clave derivada de `JWT_SECRET` **y** `ADMIN_SECRET`: conocer solo
  `JWT_SECRET` no alcanza para fabricarlo. Seguro por defecto: salvo que `NODE_ENV` sea `development`
  o `test` (`npm run dev` lo fija), el servidor no arranca si `JWT_SECRET` es el valor de ejemplo o
  tiene menos de 32 caracteres (ni `ADMIN_SECRET`/las claves de `ADMIN_ACCOUNTS` el de ejemplo o < 16).
  `POST /v1/auth/admin-session` admite 5 intentos por minuto por IP.
- **Administradores**: con `ADMIN_ACCOUNTS="ana:clave,beto:clave"` cada admin entra con su propia
  clave, así que el nombre que queda en `AdminAction` está autenticado y quitar una cuenta (o cambiarle
  la clave) revoca solo sus tokens. `ADMIN_SECRET` sigue funcionando como clave compartida: el nombre lo
  declara quien entra y queda marcado "(clave compartida)". Abonar saldo exige `Idempotency-Key` (un
  doble clic acredita una sola vez). Un admin puede restablecer cualquier contraseña y ver la temporal:
  equivale a poder entrar como cualquier jugador, por diseño.
- **Auditoría**: cada ajuste de saldo del panel de admin queda en la tabla `AdminAction`
  (quién, a quién, monto, saldo antes y después); el saldo no puede superar 2 000 000 000. La bitácora
  `GameEvent` registra los eventos del §7 aunque no haya WebSocket (`hand.dealt` con el compromiso,
  `turn.started`, `betting.updated`, `draw.completed`, `hand.finished`, `match.finished`).
- **Retención**: el barrido purga partidas terminadas hace más de `MATCH_RETENTION_DAYS` (180) con sus
  manos, acciones y eventos, y registros de admin de más de `ADMIN_ACTION_RETENTION_DAYS` (730); 0 =
  no purgar.
- **Límites**: `bigBlind ≤ startingStack` al crear la partida (si no, no se podría repartir ninguna mano).
- **Cuentas nuevas**: como cada una trae 1000 fichas, se admiten 10 altas por IP y por hora.
- **Cuentas y contraseñas**: `POST /v1/auth/session` crea la cuenta con la contraseña la primera vez
  que se usa un nombre y la verifica después (mismo mensaje de error para "no existe" y "contraseña
  incorrecta"). Los nombres anteriores a las contraseñas no tienen hash y **nadie puede reclamarlos
  entrando**: un admin les asigna una contraseña temporal desde el panel ("Asignar contraseña" /
  "Restablecer"), que se muestra una sola vez y no se guarda en claro. Cada jugador puede cambiar la
  suya (`POST /v1/auth/password`). Cambiar o restablecer una contraseña sube `Player.tokenVersion`, así
  que todos los tokens emitidos antes dejan de valer (se comprueba en cada petición). No hay
  recuperación por correo: sigue sin ser un IdP real.
- **Detrás de un proxy**: `TRUST_PROXY_HOPS` dice cuántos proxies de confianza hay delante; por defecto
  **0**, así que `X-Forwarded-For` se ignora y nadie puede fabricarse una IP por petición para esquivar
  los límites (AUD-02). **En Railway hay que poner `TRUST_PROXY_HOPS=1`**: si no, todos los clientes
  comparten la IP del proxy y el límite global por IP. Con dos proxies (CDN + balanceador), 2.
- **Límites de tasa** (§8.1): además del global de 300/min por IP, hay cupos por cuenta (login,
  10/min), por jugador (crear partidas, sesión) y por jugador y partida (60 comandos y 240 lecturas por
  minuto). Un `429` trae `retryAfterMs` en el cuerpo y `Retry-After` en la cabecera. Cada jugador tiene
  como mucho 3 long-polls abiertos por partida y 16 en total; los que pasan del tope responden al
  instante. Todo vive en memoria de cada instancia: con varias réplicas, hace falta un store compartido.
- **Cabeceras HTTP** (`src/api/securityHeaders.ts`): CSP estricta (`'self'`, sin `unsafe-inline`; el
  cliente no puede tener `<script>` ni `style=""` en línea), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, HSTS y `Cache-Control: no-store` en `/v1/*`.
- **CI** (`.github/workflows/ci.yml`): en cada push a `main` y en cada PR corre `npm ci`,
  `npm audit --omit=dev --audit-level=high`, migraciones, lint, typecheck, toda la suite contra un
  Postgres efímero y el build. Dependabot (`.github/dependabot.yml`) propone actualizaciones semanales
  de npm y de las GitHub Actions.
- **Salud y fallas de infraestructura**: `GET /health/live` solo indica que el proceso responde;
  `GET /health/ready` (y `/health`) además comprueba la BD con `SELECT 1` (timeout 1 s) y responde
  `503` si no llega — es el que debe usar el health check del despliegue. Si la BD cae a mitad de una
  petición (P1001, pool agotado P2024, etc.) la API responde `503 SERVICE_UNAVAILABLE` con
  `Retry-After: 2`, no un `500` genérico.
- **Compresión**: el cliente estático se sirve con br/gzip (`app.js` 29 KB → ~7 KB). Las respuestas
  de `/v1/*` nunca se comprimen: pesan menos de 1 KB y algunas combinan un secreto (el JWT) con
  texto del usuario, lo que explotan ataques tipo BREACH.
- **Ajustes de producción**: `connection_limit`/`pool_timeout` en `DATABASE_URL`,
  `UV_THREADPOOL_SIZE` (= vCPU), `TRUST_PROXY_HOPS`, `ADMIN_ACCOUNTS` y la retención — ver `.env.example`.
- **CI** (`.github/workflows/ci.yml`), tres jobs en paralelo contra un Postgres efímero:
  lint + tipos + tests con mínimo de cobertura + build; E2E con Playwright; y presupuesto de
  rendimiento (`scripts/loadtest.mjs --budget`).
