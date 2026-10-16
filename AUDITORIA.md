# Auditoría — Póker Five-Card Draw 1 vs 1 (`poker-1v1-api`)

- **Fecha:** 2026-10-09
- **Fuente de verdad:** `Especificacion_Poker_1v1_API.pdf` v1.0. Se respetan las decisiones documentadas en el README (el botón actúa primero en ambas rondas, timeouts perezosos, sin WebSocket, autenticación de desarrollo), salvo donde se indica.
- **Alcance:** solo auditoría. No se modificó `src/`, `public/` ni `prisma/`. Los tests de reproducción están en `test/audit/` y van aparte de `npm test`:

```bash
npx vitest run -c test/audit/vitest.config.ts
```

En el estado actual, **14 de los 30 tests de auditoría fallan a propósito**: cada fallo reproduce un hallazgo. El resto son pruebas de propiedades, fuzz y carreras que el código supera.

> **Re-auditoría del rediseño (PR #9, 2026-10-15):** sin defectos de seguridad. Tres hallazgos corregidos (R3-01 Baja; R3-02 y R3-03 Info) y uno de maquetación que queda para el diseñador (R3-04 Info); ver la **sección 8**.
>
> **Re-auditoría 2026-10-15 (cliente web):** 1 hallazgo Medio, 3 Bajos y 4 informativos sobre el front end nuevo (4 mesas, invitación por enlace); ver la **sección 7**. Todos quedaron corregidos el mismo día, con sus reproducciones como regresión en `npm test` y `npm run test:e2e` (**sección 7.5**).
>
> **Actualización 2026-10-10:** todos los hallazgos están corregidos o resueltos; ver la sección 6. Las reproducciones pasaron a la suite normal (`npm test`) como regresión, y en `test/audit/` quedan el fuzz y las propiedades del motor (`npm run test:audit`).

**Estado:** CONFIRMADO = reproducido con un test o una medición. SOSPECHA = razonado o leído en el código, sin reproducción.

---

## 1. Resumen ejecutivo

El núcleo del juego está bien construido. Mazo, evaluador, motor de apuestas, máquina de estados, timeouts, filtrado de vistas e idempotencia de una misma acción superaron pruebas de propiedades (300 000 rondas de apuestas, 200 000 duelos contra un evaluador independiente, χ² del barajado) y más de 9000 manos de fuzz por la API sin violar ningún invariante de mesa. Los defectos graves están alrededor del juego, no en sus reglas:

1. **Crítico — cartera (AUD-01):** al liquidar una partida se leen los saldos sin bloqueo y luego se escribe un valor absoluto. Una reserva, otra liquidación o un abono de admin simultáneos se pierden. Se reprodujo la creación de 1000 fichas de la nada, la destrucción de hasta 7000 y saldos que quedan bloqueados para siempre.
2. **Alto — rate limit (AUD-02):** `trustProxy` está fijo en código a "un salto". Sin un proxy delante, cualquier `X-Forwarded-For` es una IP nueva y el límite de intentos de login desaparece, lo que permite fuerza bruta de contraseñas.
3. **Medio — cartas ocultas (AUD-03):** la auditoría publica la semilla tras un fold, lo que permite reconstruir exactamente la mano que el rival no mostró.

Además, hay dos órdenes de bloqueo cruzados que provocan deadlocks deterministas con respuesta 500 (AUD-04), y varias desviaciones menores del spec: el compromiso de la semilla no se publica antes de revelarla, no se informa cuántas cartas cambió el rival, el 429 no trae `retryAfterMs`, al retirarse no se dice quién ganó la mano, el registro de acciones está incompleto y se juega una ronda de apuestas sin sentido cuando hay un all-in.

---

## 2. Hallazgos

| ID | Severidad | Área | Título | Estado | Ubicación |
| --- | --- | --- | --- | --- | --- |
| AUD-01 | **Crítica** | Economía / concurrencia | La liquidación de cartera sin bloqueo crea y destruye fichas | CONFIRMADO | `src/application/walletSettlement.ts:14-21` |
| AUD-02 | **Alta** | Seguridad API | Rate limit esquivable con `X-Forwarded-For` (`trustProxy` fijo a un salto) | CONFIRMADO | `src/api/server.ts:54`, `:68-71` |
| AUD-03 | Media | Información oculta | La semilla revelada tras un fold destapa la mano retirada (muck) | CONFIRMADO | `src/application/handQueryService.ts:85`, `:268-276` |
| AUD-04 | Media | Concurrencia | Órdenes de bloqueo cruzados → deadlock → 500 | CONFIRMADO | `src/application/forfeit.ts:70-79`; `src/application/matchService.ts:243`, `:341-346`, `:365`, `:381` |
| AUD-05 | Baja | Idempotencia | Misma `Idempotency-Key` en paralelo en dos partidas → 500 en vez de 409 | CONFIRMADO | `src/infrastructure/idempotency.ts:24-48` |
| AUD-06 | Baja | Operación / DoS | Sin tope de long-polls por usuario: un cliente degrada a todos | CONFIRMADO (medido) | `src/api/routes/matches.ts:58-100`, `src/infrastructure/matchNotifier.ts:22` |
| AUD-07 | Baja | Juego justo | El `deckCommitment` nunca se publica antes de revelar la semilla | CONFIRMADO | `src/application/handQueryService.ts:87-125`, `:251-267` |
| AUD-08 | Baja | Reglas / información pública | El jugador no puede saber cuántas cartas cambió el rival | CONFIRMADO | `src/application/handQueryService.ts:100-109`, `src/application/actionService.ts:101-118` |
| AUD-09 | Baja | API | El 429 no incluye `retryAfterMs` | CONFIRMADO | `src/api/server.ts:86-91` |
| AUD-10 | Baja | Auditoría | El registro de acciones no guarda la `Idempotency-Key` ni el estado posterior; eventos incompletos | CONFIRMADO | `src/application/actionService.ts:105-152`, `src/application/timeouts.ts:73-90` |
| AUD-11 | Baja | Reglas | Con un jugador all-in se juega igual la ronda post-draw | CONFIRMADO | `src/application/handFlow.ts:92-110`, `src/application/bettingRound.ts:24-27` |
| AUD-12 | Baja | Seguridad API | Rate limiting solo por IP; ni por usuario ni por partida (§8.1) | CONFIRMADO | `src/api/server.ts:68-71`, `src/api/routes/auth.ts:9-37` |
| AUD-13 | Baja | Cliente / información de la mano | Al retirarse, no se dice quién ganó la mano; en la mano que cierra la partida no sale ningún resultado | SOSPECHA (código + e2e existente) | `public/app.js:632`, `:678-687`; `src/application/handQueryService.ts:87-125` |
| AUD-14 | Info | Seguridad API | JWT de jugador de 12 h; revocación con caché de 5 s por instancia | SOSPECHA (código) | `src/infrastructure/auth/jwt.ts:18`, `src/infrastructure/auth/tokenVersionCache.ts:10` |
| AUD-15 | Info | IDOR menor | `join` comprueba el estado antes que la invitación: un no-miembro puede sondear partidas ajenas | CONFIRMADO | `src/application/matchService.ts:156-160` |
| AUD-16 | Info | Reglas | Abandono por desconexión (`DISCONNECT_TIMEOUT`) no está en el spec | CONFIRMADO (test existente) | `src/application/timeouts.ts:23-25`, `:141-145` |
| AUD-17 | Info | Validación | `bigBlind × 5 ≤ startingStack` es más estricto que §6.1; las ciegas 10/20 "predeterminadas" no tienen valor por defecto | SOSPECHA (código) | `src/api/schemas.ts:21-34` |
| AUD-18 | Info | Integridad de datos | Sin `CHECK` de saldos y stacks ≥ 0; `Math.max(0, …)` oculta desajustes | SOSPECHA (código) | `prisma/migrations/20260919014749_init/migration.sql:17-18`, `src/application/walletSettlement.ts:18` |
| AUD-19 | Info | Operación | `Action`, `GameEvent` y `AdminAction` crecen sin límite | SOSPECHA (código) | `src/application/maintenance.ts:98-123` |
| AUD-20 | Info | Admin | Secreto compartido: el nombre del admin lo declara quien entra; sin revocación propia | SOSPECHA (código) | `src/application/adminService.ts:17-25` |
| AUD-21 | Info | Motor | Tras devolver el excedente, el flag `allIn` sigue en `true` con fichas (inocuo en heads-up) | CONFIRMADO (propiedades) | `src/domain/bettingEngine.ts:82-98` |
| AUD-22 | Info | Economía | Cuentas ilimitadas con 1000 fichas cada una (cultivo de fichas entre cuentas) | SOSPECHA (código) | `src/application/authService.ts:34-37`, `prisma/schema.prisma:47` |
| AUD-23 | Info | Calidad de tests | Huecos que dejaron pasar AUD-01 y AUD-11; e2e con esperas fijas | CONFIRMADO (revisión) | ver detalle |

---

## 3. Detalle de cada hallazgo

### AUD-01 · Crítica · La liquidación de cartera sin bloqueo crea y destruye fichas

**Dónde.**
- `src/application/walletSettlement.ts:14-21`. `refundReservedStack` hace `findUniqueOrThrow` del `Player` sin bloqueo y después un `update` con `fictionalBalance` y `blockedBalance` **absolutos**, calculados en JS.
- Se llama desde `forfeit.ts:70-79` (abandono o desconexión), `dealing.ts:56-65` (fin por saldo insuficiente) y `matchService.ts:231-235` (cancelación).
- En cambio, `reserveStack` (`matchService.ts:60-70`) y `addPlayerBalance` (`adminService.ts:94-107`) sí bloquean con `FOR UPDATE`, aunque también escriben valores absolutos.

**Descripción.** En READ COMMITTED, cualquier transacción que confirme un cambio sobre el mismo jugador entre esa lectura y el `UPDATE` queda sobrescrita. El `FOR UPDATE` sobre `Match` no protege, por dos motivos:

- Un jugador puede tener varias partidas a la vez.
- La reserva de una partida nueva y el ajuste de admin no tocan esa fila `Match`.

Además, `Math.max(0, blocked − reserved)` esconde el desajuste en lugar de fallar.

**Reproducción** (`test/audit/walletRace.audit.ts`, 3 tests, los tres fallan):

1. **Intercalado exacto.** Una conexión aparte retiene `FOR UPDATE` sobre Alice solo para fijar el orden de llegada.
   - Partida inicial: Alice (2000 fichas) juega M1 contra Bob.
   - Alice crea M2: la reserva queda primera en la cola.
   - Bob abandona M1: `refundReservedStack` lee a Alice (1000/1000) y queda segundo en la cola.
   - Se libera el lock. M2 reserva 1000 y después la liquidación escribe con su lectura vieja.
   - **Obtenido:** Alice tiene 3000 disponibles y 0 bloqueadas con M2 abierta (esperado: 2000 / 1000). Al cancelar M2 se le devuelven 1000 que nunca se le descontaron: **el total del sistema pasa de 3000 a 4000 fichas.**
2. **Carga realista, sin ayudas.** Ocho rivales abandonan a la vez sus partidas contra el mismo jugador.
   - **Esperado:** 16 000 disponibles y 0 bloqueadas.
   - **Obtenido** en distintas corridas: 2000 / 7000 y 4000 / 6000. Es decir, **entre 6000 y 7000 fichas destruidas y otras tantas bloqueadas sin partida**.
3. **Abono de admin concurrente.** Un abono de admin de +500 llega a la vez que una liquidación. **Se pierde:** el jugador queda con 2000 en vez de 2500, aunque `AdminAction` registra el abono.

**Impacto.** Se crean y se destruyen fichas, quedan saldos bloqueados para siempre y el registro de auditoría de admin se vuelve falso. Para provocarlo basta con que un jugador tenga dos partidas activas o con un abono de admin; no hace falta ninguna acción maliciosa.

**Spec.** §1 (economía ficticia aislada), §4.1 ("todas las mutaciones se ejecutan en transacción"), §6 (`POST /matches` "inmoviliza saldo"), §9.

**Corrección recomendada.**
- **Incremento atómico** en una sola sentencia, sin leer antes:
  - `refundReservedStack`: `tx.player.update({ where: { id }, data: { blockedBalance: { decrement: reservedAmount }, fictionalBalance: { increment: finalStack } } })`.
  - `reserveStack`: `tx.player.updateMany({ where: { id, fictionalBalance: { gte: amount } }, data: { fictionalBalance: { decrement: amount }, blockedBalance: { increment: amount } } })`, y si `count === 0`, devolver `INSUFFICIENT_STACK`.
  - `addPlayerBalance`: `increment`, con la condición del tope en el `where`.
- **Alternativa:** `SELECT … FOR UPDATE` del `Player` *antes* de leerlo en `refundReservedStack`, con el orden global de AUD-04.
- **Defensa en la BD** (migración nueva): `CHECK ("fictionalBalance" >= 0)`, `CHECK ("blockedBalance" >= 0)` y `CHECK ("player1Stack" >= 0 AND "player2Stack" >= 0)`. Quitar el `Math.max(0, …)` para que un desajuste falle en lugar de esconderse.
- **Conciliación de datos existentes:** el bloqueado esperado de cada jugador es `startingStack × partidas abiertas` (ver `blockedMismatches()` en `test/audit/helpers.ts`).
- **Regresión:** pasar `walletRace.audit.ts` a la suite normal una vez corregido.

### AUD-02 · Alta · Rate limit esquivable con `X-Forwarded-For`

**Dónde.**
- `src/api/server.ts:54`: `trustProxy: (_address, hop) => hop < 1`, fijo en código y sin variable de entorno.
- `src/api/server.ts:68-71`: límite global de 300/min por IP.
- `src/api/routes/auth.ts:11` y `:31-32`: 10/min en login y 5/min en el login de admin.
- `scripts/loadtest.mjs:8-10` aprovecha este comportamiento a propósito.

**Descripción.** Al confiar en el primer salto, `request.ip` pasa a ser el último valor de `X-Forwarded-For`. Si no hay proxy delante (desarrollo, e2e, el job de rendimiento de CI o cualquier despliegue directo), ese valor lo pone el cliente, así que cada petición con una cabecera distinta cuenta como una IP nueva. Con dos proxies ocurre lo contrario: todos comparten la IP del primero y el límite global se agota para todos.

**Reproducción.**
- `test/audit/rateLimitSpoof.audit.ts`: 50 intentos de login de admin y 50 contra una misma cuenta de jugador, cada uno con una `X-Forwarded-For` distinta. Resultado: **0 de 100 respuestas 429** (se esperaban ≥ 45 y ≥ 39).
- Con `curl` contra un servidor real: con 127.0.0.1 ya bloqueado (429), 15 intentos con la cabecera cambiada devolvieron 15 × 401.

```bash
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/v1/auth/session -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.$i" -d "{\"displayName\":\"victima\",\"password\":\"intento-$i\"}"; done
```

**Impacto.** Fuerza bruta online ilimitada contra contraseñas de jugador (mínimo de 8 caracteres y sin bloqueo por cuenta), que acaba en suplantación. También contra `ADMIN_SECRET`: inviable si es aleatorio de ≥ 16 caracteres, trivial si es débil. Además, el límite global deja de frenar el abuso del long-poll (AUD-06). No aplica a un despliegue con exactamente un proxy que reescriba la cabecera (Railway, según el README); por esa precondición la severidad es Alta y no Crítica.

**Spec.** §8 (`429 RATE_LIMITED`) y §8.1 ("rate limiting por usuario y match").

**Corrección recomendada.**
- `trustProxy` configurable por entorno (p. ej. `TRUST_PROXY_HOPS`, por defecto 0) y validado al arrancar.
- Límite por cuenta en el login (`keyGenerator` con `displayName`, con retardo progresivo tras N fallos).
- Límite por usuario y partida en los comandos (ver AUD-12).
- Que `scripts/loadtest.mjs` deje de depender del spoofing, por ejemplo desactivando los límites del servidor de carga con una variable.

### AUD-03 · Media · La semilla revelada tras un fold destapa la mano retirada

**Dónde.**
- `src/application/handQueryService.ts:85`: la vista oculta las cartas cuando `winReason = FOLD`.
- `src/application/handQueryService.ts:268`: la auditoría devuelve `deckSeed` cuando la mano terminó.
- `src/application/handQueryService.ts:269-276`: devuelve también los `discardedIndexes` de ambos jugadores.
- Mismo caso con `FORFEIT` (`forfeit.ts:51`). La semilla viaja también en el evento `hand.finished` (`dealing.ts:259`).

**Descripción.** El código intenta respetar el muck, pero `GET /matches/{id}/hands/{n}` entrega la semilla. Con ella cualquiera puede rearmar la mano final de los dos jugadores:

- `shuffleWithSeed` es determinista y conocido.
- El reparto es fijo: el botón recibe las cartas 0-4, el rival las 5-9 y las reposiciones salen desde la 10, en orden de draw.
- Los descartes de cada jugador vienen en la auditoría.

Eso incluye la mano de quien ganó sin mostrar, lo que permite saber si te farolearon.

**Reproducción** (`test/audit/muckLeak.audit.ts`):
- Mano 1: Alice descarta [0, 1] y Bob [2, 4]; Bob se retira en post-draw.
- Ni la vista ni `revealedCards` muestran sus cartas.
- Alice pide `/hands/1` y reconstruye **exactamente** `['6S','2S','5H','QS','3H']`, que son las cartas de Bob en la BD.

**Impacto.** Revela cartas que el juego trata como ocultas. Solo ocurre una vez terminada la mano, así que no da ventaja dentro de ella, pero permite perfilar al rival a lo largo de la sesión. Es Media y no Crítica porque el spec exige revelar la semilla (§4.1, criterio 16): hay un conflicto entre esa exigencia y el muck que implementa la vista.

**Spec.** §2.2.6 ("si nadie se retiró, se revelan las manos"), §4.1 y criterio 16.

**Corrección recomendada** (es una decisión de producto):
- (a) Aceptarlo y documentarlo: mostrar también las cartas en la vista para no dar una falsa sensación de privacidad.
- (b) Revelar la semilla solo al terminar la **partida**: sigue siendo auditable, pero sin perfilar al rival durante la sesión.
- (c) Usar un compromiso por carta (hash con sal de cada posición del mazo, publicado al repartir) y revelar solo lo que se mostró; las cartas retiradas se verifican al final de la partida.

### AUD-04 · Media · Órdenes de bloqueo cruzados → deadlock → 500

**Dónde.**
- **(a) Liquidación.** `forfeit.ts:70-79` y `dealing.ts:56-65` actualizan los `Player` en orden de asiento (player1 → player2), no por ID.
- **(b) Revancha:**
  - Cancelar una revancha bloquea la partida nueva (`resign` → `matchService.ts:196`) y después actualiza la original (`touchRematchParent`, `:243` → `:344`).
  - `requestRematch` bloquea la original (`:365`) y después la revancha (`:381`).
  - `expireStaleInvitations` (`maintenance.ts:80-84`) sigue el mismo orden que la cancelación.

**Reproducción** (`test/audit/concurrency.audit.ts`, determinista: una conexión aparte retiene un lock para fijar el orden):
- **(a)** Alice y Bob tienen M1 (player1 = Alice) y M2 (player1 = Bob; por ejemplo, una revancha pedida por Bob). Bob abandona M1 y Alice abandona M2 a la vez. T1 bloquea a Alice y pide a Bob; T2 bloquea a Bob y pide a Alice. Una de las dos recibe **500 "Error interno del servidor"**.
- **(b)** Alice cancela su revancha mientras Bob la acepta: una de las dos peticiones responde 5xx.
- El log de Postgres registra `deadlock detected` (16 veces en dos corridas).

**Impacto.** La transacción abortada se revierte, así que no hay corrupción, pero el usuario recibe un 500 genérico. El error de deadlock de Prisma no está en `DB_UNAVAILABLE_CODES` (`server.ts:22`), así que tampoco se convierte en un 503 reintentable. El caso (a) es plausible porque cada revancha alterna quién es player1. Si AUD-01 se arregla con `FOR UPDATE` sin ordenar los bloqueos, este deadlock será más frecuente.

**Corrección recomendada.** Un **orden de bloqueo global**:
1. Primero las partidas, por ID ascendente.
2. Después los jugadores, por ID ascendente.

En concreto:
- En la liquidación, bloquear los dos jugadores de una vez: `SELECT id FROM "Player" WHERE id IN (…) ORDER BY id FOR UPDATE`, antes de tocar los saldos.
- En la revancha, que ambos caminos bloqueen la original y la revancha en orden de ID. La cancelación (y `expireStaleInvitations`) tendría que bloquear la original antes de bloquear la revancha.
- Como red de seguridad, reintentar en el servidor 1-2 veces ante un deadlock (40P01 / P2034), o responder 503 con `Retry-After`.

### AUD-05 · Baja · Misma `Idempotency-Key` en paralelo en dos partidas → 500

**Dónde.** `src/infrastructure/idempotency.ts:24-48`: busca la clave, ejecuta y luego la inserta. La unicidad `(playerId, key)` solo se comprueba al insertar, y el lock que serializa es el de cada partida, distinto en cada una.

**Reproducción** (`concurrency.audit.ts`, AUD-05). La misma clave en dos acciones simultáneas sobre M1 y M2 da `[200, 500]`. Postgres registra `duplicate key value violates unique constraint "IdempotencyRecord_playerId_key_key"`.

**Impacto.** Acotado: es un mal uso por parte del cliente y la segunda acción se revierte (no se aplica dos veces), pero devuelve 500 en lugar de `409 IDEMPOTENCY_CONFLICT` (§8). Un reintento posterior sí recibe el 409.

**Corrección recomendada.** Dos opciones:
- Capturar P2002 en `withIdempotency` y traducirlo a `IDEMPOTENCY_CONFLICT`, o a una repetición si el hash coincide.
- Reservar la clave al principio con `INSERT … ON CONFLICT DO NOTHING` y estado "en curso".

### AUD-06 · Baja · Sin tope de long-polls por usuario

**Dónde.** `src/api/routes/matches.ts:58-100` y `src/infrastructure/matchNotifier.ts:22` (`setMaxListeners(0)`). El único freno es el límite global por IP, esquivable por AUD-02.

**Reproducción** (medición con servidor real sobre una BD desechable; script en `test/audit/longpollHerd.mjs`):

| Long-polls abiertos por un mismo token | Resultado |
| --- | --- |
| 200 | Sin efecto apreciable |
| 2000 | Todas responden 200, pero al despertar a la vez la latencia de una lectura de **otro** usuario pasa de ~185 ms a ~1240 ms |
| 6000 | El cliente ya no consigue conectar (cola de `listen` del sistema operativo); el servidor sigue sano (`/health` 200, sin P2024) |

**Impacto.** Un solo cliente degrada la respuesta para todos; no se observó ninguna caída. Con un proxy bien configurado, el límite por IP acota a ~125 esperas abiertas por IP.

**Corrección recomendada.**
- Tope de esperas abiertas por jugador y partida (por ejemplo 2-4); la siguiente recibe respuesta inmediata o 429.
- Despertar con jitter, o calcular la vista una sola vez por jugador y partida para todas las esperas.

### AUD-07 · Baja · El `deckCommitment` nunca se publica antes de revelar la semilla

**Dónde.** Se guarda al repartir (`dealing.ts:127`), pero solo sale en la auditoría (`handQueryService.ts:267`), que exige la mano terminada (`:251-253`) y lo entrega junto con la semilla. No aparece en `MatchView` (`:87-125`).

**Reproducción** (`test/audit/specGaps.audit.ts`, AUD-07). Durante la mano, la vista no contiene el compromiso y `/hands/1` responde 400.

**Impacto.** El esquema de compromiso y revelación no prueba nada: el jugador recibe el hash y la semilla a la vez, así que no puede comprobar que la semilla estaba fijada antes de jugar. Ningún jugador puede explotarlo; se pierde la verificabilidad que promete el spec.

**Spec.** §1.1 ("resolución justa"), §4.1 ("registro de compromiso/revelación de semilla") y §5.1 (`Hand.deckCommitment`). El spec no dice literalmente "publicar al repartir", pero un compromiso solo tiene sentido si se publica antes de la revelación → **Parcial**.

**Corrección recomendada.** Incluir `deckCommitment` en `MatchView` desde el reparto. El cliente lo guarda y lo compara con `sha256(deckSeed)` cuando lee la auditoría.

### AUD-08 · Baja · El jugador no puede saber cuántas cartas cambió el rival

**Dónde.**
- `handQueryService.ts:100-109`: el rival solo se describe con `cardCount`, que siempre vale 5.
- El DRAW manual ni siquiera registra un evento `draw.completed` (`actionService.ts:101-118`); solo lo hace el automático (`timeouts.ts:73-79`).

**Reproducción** (`specGaps.audit.ts`, AUD-08). Alice cambia 3 cartas. La vista de Bob solo tiene `playerId`, `displayName`, `stack`, `cardCount` y `contribution`.

**Impacto.** En Five-Card Draw, cuántas cartas pide el rival es información pública y clave para la ronda final. El spec la entrega en `draw.completed.discardedCount` (§7). Dejar fuera el WebSocket es una decisión documentada y la respeto, pero el long-poll que lo sustituye no transporta este dato.

**Spec.** §7: fuera de alcance como canal, pero el dato se queda sin sustituto.

**Corrección recomendada.** Añadir `opponent.discardedCount` a `MatchView` (`null` hasta que el rival haga su draw) y registrar `draw.completed` también en el DRAW manual.

### AUD-09 · Baja · El 429 no incluye `retryAfterMs`

**Dónde.** `src/api/server.ts:86-91` lee `error.retryAfterMs`, una propiedad que `@fastify/rate-limit` nunca define. El plugin solo envía la cabecera `retry-after` en segundos y deja el `ttl` en el contexto de su `errorResponseBuilder`.

**Reproducción** (`specGaps.audit.ts`, AUD-09). El cuerpo es `{type, code, message}`, sin `retryAfterMs`; la cabecera `retry-after` sí llega.

**Spec.** §8: "429 RATE_LIMITED … Esperar `retryAfterMs`" → **No cumple**.

**Corrección recomendada.** Definir `errorResponseBuilder` en el plugin y propagar `context.ttl` como `retryAfterMs`.

### AUD-10 · Baja · Registro de acciones incompleto

**Dónde.**
- `Action.idempotencyKey` existe (`prisma/schema.prisma:177`), pero ningún `action.create` lo rellena (`actionService.ts:105-114`, `:120-128`, `:142-152`; `timeouts.ts:80-90`, `:105-114`, `:124-132`).
- No se guarda el estado posterior a cada acción.
- No se registran eventos `betting.updated` ni `turn.started`, y `draw.completed` solo para los draws automáticos.

**Reproducción** (`specGaps.audit.ts`, AUD-10). Tras una acción con clave K, `Action.idempotencyKey` es `null`; tras un DRAW manual hay 0 eventos `draw.completed`.

**Spec.** §8.1 ("registro inmutable de acción, estado anterior/posterior, idempotencyKey y marcas de tiempo") y §5.1 → **Parcial**: hay marca de tiempo y `actionVersion` (estado anterior).

**Corrección recomendada.** Pasar la clave a `action.create`, guardar `stateVersion`, stacks y pozo después de cada acción, y emitir los eventos del §7 aunque no haya WebSocket.

### AUD-11 · Baja · Con un jugador all-in se juega igual la ronda post-draw

**Dónde.**
- `src/application/handFlow.ts:92-110`: `advanceAfterBothDrew` solo salta la ronda si *ambos* están all-in.
- `src/application/bettingRound.ts:24-27`.
- `src/domain/bettingEngine.ts:210-238`: ofrece `CHECK`, `ALL_IN` y `FOLD`.

**Reproducción** (`specGaps.audit.ts`, AUD-11).
- Mano 2: Alice va all-in por 990 y Bob iguala; a Bob le quedan 20.
- Tras los dos draws, la mano queda en `BETTING_POST_DRAW` con turno de Bob y acciones `[CHECK, ALL_IN, FOLD]`, en lugar de resolverse en showdown.

**Impacto.**
- Un turno de más: hasta 60 s de espera.
- Si ese turno vence, cuenta como acción automática para la detección de desconexión (`hasBeenSilent`).
- Se ofrece FOLD sin ninguna apuesta pendiente, es decir, regalar el pozo.
- Un ALL_IN en ese punto se devuelve entero.

Si se juega bien, el resultado no cambia.

**Spec.** §2.3 (all-in: "no hay más apuestas posteriores"), §2.4 ("cuando hay all-in y no queda decisión de apuesta") y §9 ("se completa la mano sin más apuestas"). El README documenta este comportamiento; **no estoy de acuerdo con él** porque contradice el spec en tres puntos y no aporta nada al juego.

**Corrección recomendada.** En `advanceAfterBothDrew`, ir a showdown si *cualquiera* de los dos está all-in. Al cerrar la ronda pre-draw las aportaciones ya están igualadas, así que no queda decisión de apuesta. El draw se mantiene.

### AUD-12 · Baja · Rate limiting solo por IP

**Dónde.** `src/api/server.ts:68-71` (`keyGenerator` por defecto = `request.ip`) y `src/api/routes/auth.ts`. No hay límite por usuario ni por partida.

**Reproducción.** `rateLimitSpoof.audit.ts`, segundo test: 50 intentos contra la misma cuenta desde 50 IPs y ninguno se limita.

**Spec.** §8.1 ("rate limiting por usuario y match") → **No cumple**.

**Corrección recomendada.** Incluida en la de AUD-02.

### AUD-13 · Baja · Al retirarse, no se dice quién ganó la mano

**Dónde.**
- `public/app.js:678-687`: tras un fold, `showLastHandResult` muestra un aviso de 4,5 s con quién se retiró y el neto de fichas ("Te retiraste · −10 fichas" / "Ana se retiró · +10 fichas"). Nunca nombra al ganador ni dice "ganaste la mano". El e2e existente fija exactamente ese texto (`e2e/handResult.spec.ts:10-11`).
- `public/app.js:632`: el resultado de la mano solo se pide cuando sube `handNumber`. Si el fold (o un showdown) termina la partida, no se reparte mano nueva y **no aparece ningún resultado de esa última mano**; la mesa pasa directamente a "Ganaste/Perdiste la partida" con el motivo de fin (`app.js:807-813`).
- `src/application/handQueryService.ts:87-125`: `MatchView` no trae el resultado de la mano anterior. El cliente depende de una segunda llamada a `/hands/{n}`, y si falla el error se ignora en silencio (`app.js:688-690`): no se muestra nada.
- Un fold automático por tiempo agotado se anuncia igual que uno voluntario ("Te retiraste").

**Reproducción** (manual; no se ejecutó el e2e):
1. Dos navegadores, Ana y Beto, en una partida 1000 / 10 / 20. Ana es botón en la mano 1.
2. Ana pulsa "Retirarse".
3. Ana ve "Te retiraste · −10 fichas" y Beto ve "Ana se retiró · +10 fichas". Ninguno ve "Ganó Beto" ni "Ganaste la mano".
4. Variante: si con ese fold el que se retira queda por debajo de la ciega grande, no aparece ningún aviso de la mano; solo "Perdiste la partida · Un jugador se quedó sin fichas para la ciega grande."

**Impacto.** El jugador tiene que deducir el ganador por el signo de las fichas; en el aviso de quien se retira, el ganador ni siquiera aparece. En la última mano de la partida no hay resultado de la mano. No afecta a las fichas: el pozo se entrega bien al rival (`fullHand.test.ts:188-215`; en el fuzz, el pago de cada mano iguala el pozo).

**Spec.** §2.3 (Fold: "El rival gana el pozo inmediatamente"), §7 (`hand.finished` con `winnerId`, `reason` y `payout`, "Fold o showdown") y §9. El WebSocket está fuera de alcance, pero su sustituto no comunica el ganador de forma explícita → **Parcial**.

**Corrección recomendada.**
- Servidor: añadir a `MatchView` un `lastHand` con `{ number, winnerId, winReason, payout, folderId, auto }` (lo que lleva `hand.finished` en el §7), para no depender de una segunda llamada.
- Cliente: nombrar siempre al ganador, por ejemplo "Ganaste la mano · Ana se retiró · +10 fichas" y "Ganó Beto · te retiraste · −10 fichas"; distinguir el fold por tiempo agotado; mostrar también el resultado de la mano que cierra la partida (condición de `app.js:632`).
- Tests: que `e2e/handResult.spec.ts` exija el nombre del ganador y cubra la mano que termina la partida.

### Hallazgos informativos (AUD-14 … AUD-23)

- **AUD-14 · JWT y revocación.**
  - El token de jugador dura 12 h (`jwt.ts:18`); §8.1 pide "expiración corta" sin dar una cifra. Recomendación: 15-60 min con renovación.
  - La revocación por `tokenVersion` se cachea 5 s por instancia (`tokenVersionCache.ts:10`). El trade-off está documentado.
  - En `changePassword` (`authService.ts:65-69`), una lectura concurrente puede volver a cachear la versión vieja justo después del `forget`; la ventana es de ≤ 5 s.
- **AUD-15 · Sondeo de partidas ajenas.** `joinMatch` comprueba el estado antes que la invitación (`matchService.ts:156-160`). Un no-miembro recibe 400 ("ya no acepta un segundo jugador") en vez de 403, y con eso distingue partidas en espera de partidas en curso. Los IDs son cuid, así que es poco práctico. Lo observé en `concurrency.audit.ts` ("un tercero con el joinToken…").
- **AUD-16 · Abandono por desconexión.** Hay un abandono automático tras ~3 min de silencio (`timeouts.ts:23-25`, `:141-145`). No está en el spec: §9 solo dice que se aplique la regla de timeout. **Estoy de acuerdo con la extensión**: sin ella, una partida sin ninguno de los dos jugadores no termina nunca. Cada mano el botón cede la ciega chica y los stacks oscilan sin llegar a cero, así que los saldos quedarían bloqueados para siempre. Conviene llevarla al spec.
- **AUD-17 · Validaciones de creación.** `bigBlind × 5 ≤ startingStack` (`schemas.ts:30-34`) rechaza combinaciones que el §6.1 permite (por ejemplo 100 / 20 / 50); está documentado en el README. Además, las ciegas son obligatorias en la API aunque el §2.1 las da como "predeterminadas" (10/20).
- **AUD-18 · Sin restricciones en la BD.** No hay `CHECK` de saldos ni stacks ≥ 0 en la BD, y `Math.max(0, …)` en `walletSettlement.ts:18` convierte errores en silencio. Ver la corrección de AUD-01.
- **AUD-19 · Tablas sin purga.** Solo se purga `IdempotencyRecord` (`maintenance.ts:98-108`); `Action`, `GameEvent` y `AdminAction` crecen sin límite. Recomendación: archivar por partida terminada. Por otro lado, reutilizar una `Idempotency-Key` después de 24 h vuelve a ejecutar la petición (por ejemplo, crea otra partida); está documentado.
- **AUD-20 · Admin.**
  - El acceso es con un secreto compartido y el `displayName` lo declara quien entra (`adminService.ts:17-25`), así que `AdminAction.adminName` no identifica a una persona.
  - Los tokens de admin (4 h) solo se revocan rotando `ADMIN_SECRET`.
  - `add-balance` no exige `Idempotency-Key`: un doble clic acredita dos veces.
  - El admin puede restablecer cualquier contraseña y recibir la temporal, lo que equivale a poder entrar como cualquier jugador. Es así por diseño, pero conviene saberlo.
- **AUD-21 · Flag `allIn` tras el reembolso.** Al devolver el excedente, el que más puso conserva `allIn = true` aunque recupere fichas (`bettingEngine.ts:82-98`). Es inocuo en heads-up porque el rival también está all-in y no queda decisión de apuesta. Lo detectó el test de propiedades del motor.
- **AUD-22 · Cultivo de fichas.** El login crea una cuenta con 1000 fichas (`authService.ts:34-37`, `schema.prisma:47`) sin límite de cuentas, así que se pueden juntar fichas pasándolas entre cuentas propias. La economía es ficticia (§1), así que el impacto es nulo mientras no tenga valor.
- **AUD-23 · Calidad de los tests** (área G):
  - `fullHand.test.ts:163-168` acepta `SHOWDOWN` o `SPLIT` sin comprobar quién gana ni el pago, porque no hay forma de inyectar un mazo en los tests de integración. Recomendación: inyectar la semilla mediante un parámetro.
  - Ningún test liquida dos partidas del mismo jugador a la vez ni comprueba Σ(disponible + bloqueado) bajo concurrencia; por eso pasó AUD-01.
  - Las ramas de draw vacío y de check automático de `timeouts.ts` estaban sin cubrir (66 %); `timeoutRules.audit.ts` las cubre y conviene moverlo a la suite normal.
  - Ningún test cubre la ronda post-draw con un all-in (AUD-11).
  - `e2e/handResult.spec.ts:10-11` fija un aviso de fold que no nombra al ganador y no cubre la mano que termina la partida (AUD-13).
  - El e2e usa esperas fijas (`realtime.spec.ts:26`, `:36`, `:38`, `:45`, `:55`; `accessibility.spec.ts:55`): lentas y frágiles en un CI cargado.

---

## 4. Matriz de cumplimiento del spec

| Sección | Requisito | Estado | Evidencia / comentario |
| --- | --- | --- | --- |
| §2.1 | Saldo inicial, ciegas, 52 cartas, 5 cartas, draw 0–5, turno configurable | Cumple | `schemas.ts`, `deck.ts`; ciegas sin valor por defecto (AUD-17) |
| §2.1 | Reglas bloqueadas una vez empezada la partida | Cumple | No hay endpoint que las cambie; la revancha las copia (`rematch.test.ts`) |
| §2.1 / §9 | Fin de sesión cuando alguno no cubre la ciega grande | Cumple | `dealing.ts:36-80`, `allInAndTermination.test.ts` |
| §2.2 | Rotación del botón; el botón pone la ciega chica | Cumple | `dealing.ts:19-22`, `:92-93` |
| §2.2 | El botón actúa primero en pre-draw, draw y post-draw | Cumple | Decisión documentada; fuzz |
| §2.2 | Nueva mano solo si ambos cubren la entrada | Cumple | `dealing.ts:36-38` |
| §2.3 | Draw solo en DRAW y en el turno del jugador; Bet = check/call/raise; Fold | Cumple | `stateMachine.ts`; fuzz: 0 acciones ilegales aceptadas |
| §2.3 | All-in: "no hay más apuestas posteriores" | Parcial | AUD-11 |
| §2.4 | Apuesta mínima = ciega grande; raise ≥ último raise completo | Cumple | Propiedades: 300 000 rondas |
| §2.4 | All-in parcial; un solo pozo; devolución del excedente | Cumple | Propiedades + `allInAndTermination.test.ts` |
| §2.4 | Cierre de ronda (ambos actuaron e igualaron, fold, all-in sin decisión) | Parcial | AUD-11 |
| §2.4 | Timeout: draw vacío / check / fold | Cumple | `timeoutRules.audit.ts` (4/4) |
| §2.5 | Jerarquía, rueda A-2-3-4-5, kickers, empate exacto | Cumple | 200 000 duelos contra un evaluador de referencia |
| §2.5 / §9 | Pozo dividido; ficha impar al botón | Cumple | `dealing.ts:176-183`. En heads-up las aportaciones quedan igualadas, así que la ficha impar no llega a darse |
| §3 | 8 estados y transiciones; nada fuera de turno ni de fase | Cumple | Fuzz + concurrencia (HAND_SETUP y SHOWDOWN son transitorios) |
| §3 | `actionVersion` → 409 STALE_STATE con el estado actual, sin alterar nada | Cumple | Tests existentes + fuzz |
| §4 | El navegador nunca recibe cartas del rival ni la semilla con la mano activa | Cumple | El fuzz lo comprueba en cada paso de ≥ 3000 manos |
| §4.1 | RNG criptográfico (`randomBytes`), Fisher-Yates sin sesgo | Cumple | χ² 52×52 con 40 000 barajados |
| §4.1 | Compromiso y revelación de la semilla | Parcial | AUD-07 |
| §4.1 | Mutaciones en transacción con bloqueo por `matchId` | Parcial | Las partidas sí; los saldos no (AUD-01, AUD-04) |
| §4.1 | Solo el showdown revela ambas manos | Parcial | AUD-03 |
| §5 | `/v1`, JSON, ISO 8601, enteros, problem+json con `code`/`message`/`details`/`currentState` | Cumple | Sin stack traces en 4xx/5xx (fuzz) |
| §5 | Bearer JWT | Cumple (stub) | Algoritmo fijado, `aud`, `exp`; ver AUD-14 |
| §5 | `Idempotency-Key` UUID obligatoria en los POST de comandos | Cumple | `idempotencyHeader.ts`; AUD-05 en el caso concurrente |
| §5.1 | Player, Match, Hand, Action, GameEvent | Parcial | `Action.idempotencyKey` nunca se rellena; eventos incompletos (AUD-10) |
| §6 | Los 8 endpoints con sus códigos | Cumple | `routes/*.ts` |
| §6.1 | Validación de `POST /matches` | Cumple | Más estricta que el spec (AUD-17) |
| §6.2 | DRAW con índices únicos 0–4; BET 0/N; ALL_IN; FOLD; forma de la respuesta | Cumple | Fuzz: duplicados, fuera de rango, decimales, negativos y gigantes, todos rechazados |
| §6.3 | MatchView filtrada (`you.cards`, `opponent.cardCount`, `turn`, `legalActions`) | Cumple | `handQueryService.ts:65-126` |
| §7 | WebSocket y eventos | Fuera de alcance | README. Sin sustituto para `discardedCount` (AUD-08) ni para el `winnerId` de `hand.finished` en un fold (AUD-13) |
| §8 | 400/401/403/404/409/409/422 | Cumple | Tests existentes + fuzz |
| §8 | 429 con `retryAfterMs` | No cumple | AUD-09 |
| §8.1 | TLS | No verificable | HSTS presente; depende del despliegue |
| §8.1 | JWT con expiración corta | Parcial | 12 h (AUD-14) |
| §8.1 | Autorización por `matchId` | Cumple | Sin IDOR de lectura ni de acción; AUD-15 menor |
| §8.1 | Registro inmutable con `idempotencyKey` y estado anterior/posterior | Parcial | AUD-10 |
| §8.1 | Rate limiting por usuario y partida | No cumple | Solo por IP y esquivable (AUD-02, AUD-12) |
| §8.1 | Una acción por turno y bloqueo transaccional | Cumple | `concurrency.audit.ts` (doble envío, acciones en paralelo) |
| §8.1 | Validación estricta, enteros, índices sin repetición | Cumple | Zod + motor; fuzz |
| §8.1 | Saldo ficticio separado | Cumple | Integridad rota por concurrencia (AUD-01) |
| §9 | Fold, showdown, saldo inferior, abandono | Cumple | Tests + fuzz. Al retirarse, el cliente no nombra al ganador (AUD-13) |
| §9 | All-in "sin más apuestas" | Parcial | AUD-11 |
| §9 | Desconexión: se mantiene el turno y al vencer se aplica la regla | Cumple + extensión | AUD-16 |
| §10.8 | Crear y unirse a una partida de 1000 fichas con ciegas 10/20 | Cumple | `fullHand.test.ts` |
| §10.9 | Cada jugador solo ve sus cartas; el rival como `cardCount` | Cumple | Fuzz |
| §10.10 | El cliente bloquea botones ilegales y la API los rechaza | API: cumple; cliente: no verificado | No se ejecutó el e2e |
| §10.11 | Draw de 0 a 5 índices únicos, una sola vez por mano | Cumple | `drawPhase.ts:32-34` + fuzz |
| §10.12 | Check, call, raise, all-in y fold correctos | Cumple | Propiedades + fuzz |
| §10.13 | Misma clave → mismo resultado sin duplicar fichas | Cumple | `concurrency.audit.ts` (5 envíos simultáneos) |
| §10.14 | Versión desactualizada → 409 sin alterar el estado | Cumple | Tests + fuzz |
| §10.15 | Fin de sesión al agotar saldo, comunicado por REST y WebSocket | Cumple por REST | WebSocket fuera de alcance |
| §10.16 | La auditoría muestra aportaciones, acciones, resultado y semilla | Cumple | Ver AUD-03 y AUD-07 |

---

## 5. Revisado sin defectos y no verificado

### Revisado sin defectos

- **Entorno y suite.** `npm run lint` y `npm run typecheck` en verde; 142 tests en verde (20 ficheros). Cobertura: 88,8 % de sentencias, 82,3 % de ramas y 90,8 % de funciones; lo menos cubierto es `timeouts.ts` (66 %). `npm audit`: 0 vulnerabilidades. Prisma 5, zod 3 y `@fastify/rate-limit` 10 están una o dos versiones mayores por detrás (informativo).
- **Mazo.** Semilla de `randomBytes(32)`, Fisher-Yates con rechazo para evitar el sesgo de módulo y χ² 52×52 con 40 000 barajados dentro de lo esperado. No hay duplicados: 52 cartas, como máximo 20 usadas por mano (10 + 10 reposiciones), así que nunca faltan. La semilla de la mano en curso no aparece en ninguna respuesta.
- **Evaluador.** Coincide con un evaluador de referencia independiente (`test/audit/reference.ts`) en 200 000 duelos aleatorios, además de casos límite: rueda, escalera real, kickers de doble pareja y empate exacto.
- **Motor de apuestas** (`engineProperties.audit.ts`, 300 000 rondas). Las fichas se conservan por asiento, la ronda siempre cierra con aportaciones igualadas, nunca se da el turno a un jugador all-in y `legalBettingActions` anuncia exactamente lo que el motor acepta.
- **Fuzz por la API** (`apiFuzz.audit.ts`). Siete corridas completas (más de 9000 manos), todas con **0 violaciones**. La última, con tres semillas de 1500 manos (314159, 7 y 8), sumó 4502 manos en 1469 partidas: 13 664 acciones legales, 4800 ilegales (todas rechazadas con 4xx y sin cambiar nada), 1131 repeticiones idempotentes, 1885 timeouts, 325 abandonos, 1703 showdowns y 2461 folds. Tras **cada** paso se comprobó:
  - stacks + pozo = 2 × stack inicial;
  - Σ(disponible + bloqueado) constante;
  - bloqueado = stack inicial × partidas abiertas;
  - las acciones rechazadas no alteran nada y devuelven problem+json sin stack trace;
  - ninguna vista expone cartas del rival ni la semilla;
  - 10 cartas distintas en mano;
  - cada showdown paga a la mano que indica el evaluador de referencia;
  - las repeticiones idempotentes devuelven el mismo `actionId` y una clave reutilizada con otro cuerpo da 409.
- **Concurrencia** (`concurrency.audit.ts`). Cinco envíos simultáneos con la misma clave producen una sola ejecución; con claves distintas, uno gana y el resto recibe 409. BET y FOLD en paralelo: solo una se aplica. Acción + dos lecturas + barrido sobre un turno vencido (20 rondas): un solo efecto por turno; un timeout nunca se aplica dos veces ni se queda sin aplicar. Tres uniones simultáneas: una entra y la reserva se cobra una vez. Tres peticiones de revancha simultáneas: una sola partida nueva.
- **Timeouts** (`timeoutRules.audit.ts`). La regla del §2.4 se cumple en todas las fases.
- **Seguridad HTTP.**
  - JWT con algoritmo fijado (`alg: none` → 401), `aud` separado para jugador y admin, y clave de admin derivada de los dos secretos.
  - Contraseñas con scrypt, sal aleatoria y comparación en tiempo constante; el mismo mensaje para "no existe" y "contraseña incorrecta". El secreto de admin se compara en tiempo constante sobre digests.
  - Arranque seguro por defecto ante secretos débiles.
  - JSON malformado → 400; cuerpo de 2 MB → 413.
  - Estáticos sin path traversal (`/../.env` → 403/404).
  - CSP estricta, `X-Frame-Options`, `nosniff` y `no-store` en `/v1/*`; las respuestas de la API no se comprimen.
  - Errores 500 sin stack trace.
- **Cliente** (`public/`). Todo el texto del usuario o del rival se pinta con `textContent`; `innerHTML` solo se usa para vaciar contenedores. El token se guarda en `sessionStorage`, con la CSP como defensa en profundidad.
- **IDOR.** Las lecturas y acciones de partidas, manos y auditorías ajenas responden 403/404. Las respuestas idempotentes se guardan por `(playerId, key)`, así que no se puede obtener la de otro jugador. Solo el invitado puede unirse, aunque otro tenga el `joinToken`.

### No verificado

- **E2E con Playwright.** No se ejecutó: el usuario interrumpió esa ejecución en la sesión anterior. El bloqueo de botones en el cliente (criterio 10) y el comportamiento móvil quedan sin verificar por ejecución; solo se revisó el código estático.
- **Despliegue real.** Detrás de uno o dos proxies, TLS, varias instancias (caché de `tokenVersion`, barrido con `SKIP LOCKED` entre procesos) y PgBouncer en modo transacción (sin `LISTEN`). Nada de esto se puede reproducir en local.
- **Caída de Postgres a mitad de transacción.** Solo razonado: cada liquidación ocurre dentro de una única transacción, así que una caída la revierte entera. No se forzó.
- **`scripts/loadtest.mjs --budget`.** No se ejecutó el presupuesto de CI; en su lugar se midió el long-poll con `test/audit/longpollHerd.mjs` (AUD-06).
- **Pozo dividido por la API.** No hubo ningún empate en los 1703 showdowns del fuzz, y la rama (`dealing.ts:176-183`) tampoco tiene cobertura en la suite normal. Se revisó por lectura y el evaluador acierta los empates exactos en los tests de propiedades, pero el reparto del pozo dividido no se ejecutó de extremo a extremo.
- **Corrida lenta del fuzz.** En la sesión anterior, una corrida con la semilla 314159 agotó su timeout de 450 s. Repetida con un detector de manos atascadas (150 pasos sin terminar una mano) y registro de progreso, terminó en 205 s a ritmo normal y sin manos atascadas. No se pudo repetir el mismo camino (ver el punto siguiente), así que no se atribuye a un defecto.
- **Reproducibilidad del fuzz.** El fuzz no es exactamente reproducible por semilla: la semilla fija la secuencia de decisiones, pero el reparto usa el CSPRNG del servidor.

---

## 6. Estado de las correcciones (2026-10-10)

Todas las pruebas de regresión están en `npm test` (199 tests). El fuzz (`npm run test:audit`) se corrió además con 1000 manos y las semillas 7 y 314159, sin violaciones; los 36 E2E (escritorio y móvil) pasan.

| ID | Resolución | Regresión |
| --- | --- | --- |
| AUD-01 | Todos los cambios de saldo son incrementos atómicos (`walletSettlement.ts`: `reserveStack` con la condición en el `WHERE`, liquidación con `decrement`/`increment`, abono de admin con el tope en el `WHERE`). Se quitó `Math.max(0, …)`. `npm run reconcile` concilia datos ya dañados. | `walletConcurrency.test.ts` (los 3 escenarios de la auditoría) |
| AUD-02 | `TRUST_PROXY_HOPS` (por defecto 0, validado al arrancar). Límite de login por cuenta además del de IP. El loadtest y el fuzz ya no falsifican `X-Forwarded-For`: usan `RATE_LIMIT_DISABLED` (solo development/test). **En Railway hay que fijar `TRUST_PROXY_HOPS=1`.** | `rateLimits.test.ts` |
| AUD-03 | Opción (b): la semilla de cada mano se revela al terminar la **partida** (`matchEnd.ts`), ya no viaja en `hand.finished`. Documentado como desviación consciente del §4.1/criterio 16. | `fairPlay.test.ts` |
| AUD-04 | Orden global de locks (`locks.ts`): clave → partida original → revancha → jugadores por id, de una vez (`FOR NO KEY UPDATE`). Red de seguridad: `runTransaction` reintenta ante 40P01/40001 y, si se agota, 503 con `Retry-After`. | `concurrency.test.ts` (ambos escenarios) |
| AUD-05 | La clave se reserva al principio con `INSERT … ON CONFLICT DO NOTHING`; la petición simultánea espera y recibe la repetición o `409`. | `concurrency.test.ts` |
| AUD-06 | Tope de 3 long-polls por jugador y partida y 16 por jugador; los demás responden al instante. Más el límite de lecturas por partida (240/min). | `rateLimits.test.ts` |
| AUD-07 | `deckCommitment` en `MatchView` y en el evento `hand.dealt` desde el reparto. | `fairPlay.test.ts`, `fullHand.test.ts` |
| AUD-08 | `opponent.discardedCount` en la vista (columnas `player*DiscardedCount`); `draw.completed` también para el draw manual. El cliente muestra "Cambió N cartas". | `fairPlay.test.ts` |
| AUD-09 | `errorResponseBuilder` propaga el `ttl` como `retryAfterMs`; los límites propios también. | `rateLimits.test.ts` |
| AUD-10 | `Action.idempotencyKey` y `Action.stateAfter`; eventos `betting.updated`, `turn.started` y `draw.completed`. | `fairPlay.test.ts` |
| AUD-11 | Con cualquier jugador all-in, tras el draw se va a showdown. README actualizado. | `fairPlay.test.ts` |
| AUD-12 | Límites por cuenta, por jugador y por jugador y partida (`src/api/rateLimits.ts`). | `rateLimits.test.ts` |
| AUD-13 | `MatchView.lastHand` (ganador, motivo, pago, neto, quién se retiró, si fue por tiempo, cartas del showdown). El cliente nombra siempre al ganador, distingue el retiro por tiempo y muestra también la mano que cierra la partida. | `fairPlay.test.ts`, `e2e/handResult.spec.ts` |
| AUD-14 | Token de jugador de 1 h con renovación (`POST /v1/auth/refresh`, el cliente la programa sola). La caché de `tokenVersion` nunca baja de versión. | `passwordLogin.test.ts` |
| AUD-15 | `join` comprueba la invitación antes que el estado: un no invitado recibe siempre 403. | `concurrency.test.ts` |
| AUD-16 | Se mantiene la extensión y se documenta como tal en el README. | `securityRegressions.test.ts` |
| AUD-17 | Ciegas opcionales con 10/20 por defecto; la regla × 5 pasó a `bigBlind ≤ startingStack`. | `securityRegressions.test.ts` |
| AUD-18 | `CHECK` de saldos ≥ 0 y stacks ≥ 0 (migración `20261010150000_audit_fixes`). | `walletConcurrency.test.ts` |
| AUD-19 | Purga de partidas terminadas (con manos, acciones y eventos) y de `AdminAction`, con retención configurable. | `maintenance.test.ts` |
| AUD-20 | `ADMIN_ACCOUNTS` con clave por admin (nombre autenticado, revocación propia); la clave compartida queda marcada en la auditoría; `add-balance` exige `Idempotency-Key`. | `admin.test.ts` |
| AUD-21 | Quien recupera el excedente deja de figurar all-in. | `bettingEngine.test.ts`, `fairPlay.test.ts` |
| AUD-22 | Máximo 10 altas de cuenta por IP y por hora. | `rateLimits.test.ts` |
| AUD-23 | Semilla inyectable en tests (`setSeedSourceForTests`, solo con `NODE_ENV=test`): `fullHand.test.ts` afirma ganador y pago. Reproducciones movidas a la suite normal. E2E sin esperas fijas de sincronización (las que quedan son la propia medición). | — |

Cambios de producto pedidos durante las correcciones, que también afectan a las reglas: al abandonar o desconectarse, el jugador conserva su stack (pierde solo lo apostado en la mano en curso); stack inicial por defecto de 300; ciegas incrementales opcionales (cada 3 manos, +5 % del stack inicial); y el cliente juega hasta 4 partidas a la vez en pantalla dividida.

---

## 7. Re-auditoría del cliente web (2026-10-15)

**Alcance.** Los cambios del front end posteriores a la auditoría: `public/app.js` reescrito (hasta 4 mesas en pantalla dividida, invitación por enlace, resultado de la mano, renovación del token), `public/index.html`, `public/styles.css`, `public/admin.js`, y las rutas del servidor que usa el cliente nuevo (`src/api/routes/matches.ts`, `src/api/rateLimits.ts`, `previewInvitation`/`joinMatch` en `src/application/matchService.ts`, `lastHand`/`linkInvitation` en `src/application/handQueryService.ts`). Commits `c8de1e7` y `cd68fb9`, comparados con `f17a0c3`.

**Estado de partida.** `npm run lint` y `npm run typecheck` en verde; `npm test`: 205 tests en 28 ficheros, cobertura de `src/` del 90,5 % de sentencias (el cliente solo lo cubre el e2e). E2E del proyecto: **40/40** (escritorio y móvil, 4,1 min); en la primera auditoría no se había podido ejecutar (§5). Suite de auditoría: propiedades del motor y fuzz de 150 manos sin violaciones.

**Cómo se reprodujo.** Con `test/audit/longPollCap.audit.ts` (Vitest) y `test/audit/e2e/client.audit.spec.ts` (Playwright), que se citan abajo. Al corregir, esas reproducciones pasaron a la suite permanente y se borraron de `test/audit/`: ver **7.5**.

### 7.1 Hallazgos

| ID | Severidad | Área | Título | Estado | Ubicación |
| --- | --- | --- | --- | --- | --- |
| R2-02 | Media | Cliente / idempotencia | Doble clic en «Invitar» o «Crear partida con enlace» crea dos partidas y reserva la entrada dos veces; en «Jugar», dos uniones y un error falso | CONFIRMADO | `public/app.js:130`, `:1318-1337`, `:1431-1465` |
| R2-01 | Baja | Cliente + API / DoS | Con el tope de long-polls superado (misma cuenta y partida en 4 navegadores o dispositivos), el cliente entra en un bucle sin pausa y deja al jugador **59 s sin ver su partida** en todos ellos | CONFIRMADO | `src/api/routes/matches.ts:102-104`, `:124-127`; `public/app.js:637-651`; `src/api/rateLimits.ts:55-56`, `:67` |
| R2-03 | Baja | Cliente / errores | Un 502/504 en HTML de un proxy se muestra como «Unexpected token '<' … is not valid JSON» | CONFIRMADO | `public/app.js:139-140`, `public/admin.js:53-54` |
| R2-04 | Baja | Cliente | La selección de descarte sobrevive a la mano: tras turnos vencidos, el DRAW siguiente aparece con cartas ya marcadas | CONFIRMADO | `public/app.js:582`, `:1042` |
| R2-05 | Info | Cliente | Perder por inactividad (`DISCONNECT_TIMEOUT`) se anuncia en la mesa como «Abandonaste» | SOSPECHA (código) | `public/app.js:792-793` |
| R2-06 | Info | Cliente | Cerrar la mesa mientras responde la revancha rompe `replaceTable` (la revancha se crea pero no se abre) | SOSPECHA (código) | `public/app.js:507-522`, `:1140-1153` |
| R2-07 | Info | Cliente / UX | «Crear partida con enlace» no pasa por la validación HTML del formulario; un valor inválido llega como «Cuerpo de solicitud inválido» | SOSPECHA (código) | `public/index.html:101-103`, `public/app.js:1431-1465` |
| R2-08 | Info | Calidad de tests | El e2e no cubre doble clic, errores no JSON ni topes de long-poll | CONFIRMADO (revisión) | `e2e/*.spec.ts` |

### 7.2 Detalle

#### R2-01 · Baja · Tope de long-polls superado: bucle sin pausa y 59 s sin lecturas

**Descripción.** La corrección de AUD-06 limita las esperas abiertas a 3 por jugador y partida y 16 por jugador; las que pasan del tope se **responden al instante con 200 y la misma versión** (`matches.ts:102-104` y `:124-127`). El bucle del cliente (`Table.pollLoop`, `app.js:637-651`) vuelve a preguntar enseguida con el mismo `since`, sin ninguna pausa. En menos de 1,5 s agota el cupo de lecturas de **ese jugador en esa partida** (240/min, clave `jugador|partida`, `rateLimits.ts:55-56` y `:67`), y a partir de ahí **todas** sus pestañas reciben 429 sobre esa partida durante el resto del minuto. Al liberarse el cupo, la pestaña sobrante lo vuelve a vaciar.

**Cuándo pasa.** Con la misma cuenta y la misma partida abiertas a la vez en 4 navegadores o dispositivos (o más de 16 esperas en total). Con 4 pestañas de un mismo perfil de Chromium **no** se reproduce: Playwright lo comprobó, probablemente porque Chromium no lanza a la vez GETs idénticos en curso (la misma URL `?since=V`). Con 4 contextos separados, que equivalen a 4 navegadores, sí: **235 long-polls en 10 s** y respuestas 429 (`test/audit/e2e/client.audit.spec.ts`, «la misma mesa en 4 navegadores»).

**Reproducción** (`test/audit/longPollCap.audit.ts`). Tres long-polls de Alice quedan abiertos; la cuarta pestaña repite el bucle de `pollLoop`.
- **Obtenido:** **237 peticiones en 0,7–1,4 s**, la última 429; la lectura normal de otra pestaña de Alice → **429, bloqueada 59 s**.
- **Esperado:** como mucho unas pocas peticiones, y las demás pestañas siguen leyendo.

**Impacto.** El jugador no ve las jugadas del rival ni su propio turno durante ~1 minuto, cada minuto. Con turnos de 15–60 s se le aplican check o fold automáticos y, tras ~3 min de acciones automáticas, pierde la partida por `DISCONNECT_TIMEOUT`. No afecta a otros jugadores. Severidad Baja: la precondición (4 navegadores o dispositivos con la misma cuenta y partida) es poco habitual, aunque el arreglo es barato.

**Corrección recomendada.**
- **Servidor:** responder la espera sobrante con `429` y un `retryAfterMs` corto (2–5 s), que el cliente ya respeta (`app.js:685`). Alternativa: cerrar la espera más vieja de ese jugador y partida, y que la nueva pestaña se quede con el long-poll.
- **Cliente:** si un long-poll vuelve con la misma `stateVersion`, esperar 1–2 s con jitter antes de repetir. Así ningún comportamiento del servidor puede provocar un bucle.
- **Límite de lecturas:** que las respuestas inmediatas a esperas sobrantes no consuman el cupo de las pestañas que sí esperan; por ejemplo, contarlas aparte.

#### R2-02 · Media · Doble clic: dos partidas, dos reservas, y un error falso al aceptar

**Descripción.**
- `createMatchFromForm` (`app.js:1431-1459`) no desactiva «Invitar» ni «Crear partida con enlace» mientras la petición está en curso.
- `api()` genera una `Idempotency-Key` **nueva en cada llamada** (`app.js:130`), así que el servidor no puede reconocer el segundo clic como repetición.
- `acceptInvitation` («Jugar», `app.js:1318-1337`) tampoco se desactiva.
- En cambio, las acciones de juego y la revancha sí desactivan sus botones (`app.js:1035-1036`, `:1143-1144`), y el panel de admin ya reutiliza la clave por intención (`pendingCreditKeys`, `admin.js`).

**Reproducción** (`test/audit/e2e/client.audit.spec.ts`, Chromium):
- Doble clic en «Invitar»: **2** `POST /v1/matches`, **2** partidas abiertas y **600** fichas bloqueadas (una entrada son 300).
- Doble clic en «Crear partida con enlace»: **2** partidas.
- Doble clic en «Jugar»: **2** `POST …/join`; ya sentado en la mesa, el jugador ve el aviso «La partida ya no acepta un segundo jugador».

**Impacto.** Partidas duplicadas, la entrada reservada dos veces (recuperable abandonando la sobrante o esperando 24 h a que caduque) y, si se invitó por ID, el rival recibe dos invitaciones. En «Jugar», un mensaje de error engañoso. El spec pide un contrato «resistente a doble clic, recargas y mensajes tardíos» (§1.1), y la `Idempotency-Key` del §5 solo sirve si se reutiliza para la misma intención.

**Corrección recomendada.**
- Desactivar los botones que disparan la petición mientras está en curso, como ya hacen las acciones de juego.
- Generar la clave por **intención** (al enviar el formulario o pulsar «Jugar») y reutilizarla si el usuario reintenta tras un error de red, como `admin.js`.

#### R2-03 · Baja · Errores no JSON mostrados como error de parseo

**Descripción.** `api()` hace `JSON.parse` del cuerpo antes de mirar `res.ok` (`app.js:139-140`; igual en `admin.js:53-54`). Una página de error HTML de un proxy o balanceador (502, 504, mantenimiento) lanza `SyntaxError`, y su texto llega al usuario.

**Reproducción** (Playwright, con `POST …/actions` interceptado para responder 502 en HTML). Al pulsar «Retirarse», la mesa muestra: «Unexpected token '<', "<html><bod"... is not valid JSON». En el long-poll el mismo error solo queda en consola y se reintenta.

**Corrección recomendada.**
- Parsear JSON solo si `content-type` incluye `json` (`application/problem+json` incluido).
- En otro caso, devolver un `ApiError` con un mensaje como «El servidor no responde; reintenta en unos segundos».
- Tratar 502/503/504 como reintentables.

#### Bajo e informativos (R2-04 … R2-08)

- **R2-04 · Baja · CONFIRMADO · Selección de descarte.** `selectedDiscardIndexes` solo se vacía con una acción enviada con éxito (`app.js:1042`), no al empezar mano. En el flujo normal no se nota: antes del DRAW siguiente el jugador tiene que pasar o igualar, y eso la vacía (control de Playwright). Pero si todas sus acciones intermedias son automáticas (turnos vencidos) o entra all-in con la ciega, sobrevive. Playwright lo reproduce: Ana marca dos cartas en la mano 1 y deja vencer todo hasta el DRAW de la mano 2, que aparece con «2 cartas marcadas para cambiar» y el botón «Cambiar 2». Cartas que nunca eligió se descartarían con un solo clic. Conviene vaciarla cuando deja de ser su DRAW.
- **R2-05 · «Abandonaste» por inactividad.** `lastHand.winReason` es `FORFEIT` tanto para un abandono como para una desconexión, y la mesa dice «Abandonaste» (`app.js:792-793`), mientras el panel final dice «Por inactividad». Conviene usar `view.finishReason`.
- **R2-06 · Revancha con la mesa cerrada.** `replaceTable` (`app.js:507-522`) da por hecho que la mesa original sigue abierta. Si se cierra mientras responde `POST …/rematch`, `old.root` es `undefined` y lanza `TypeError`: la revancha queda creada (aparece en «Tus partidas») pero no se abre.
- **R2-07 · Validación del enlace.** «Crear partida con enlace» es `type="button"` (`index.html:103`) y se salta la validación HTML del formulario. Un valor inválido llega al servidor, que lo rechaza bien, pero el usuario solo ve «Cuerpo de solicitud inválido». Conviene llamar a `form.reportValidity()` antes de enviar.
- **R2-08 · Huecos del e2e.** No hay pruebas de doble clic, de respuestas no JSON ni de varias pestañas sobre la misma partida (R2-01 a R2-03). Las esperas fijas que quedan (`realtime.spec.ts:39` y `:57`) son la propia medición de «no consultar», así que están justificadas.

### 7.3 Revisado sin defectos

- **XSS.** Todo texto del usuario o del rival se pinta con `textContent` o `setAttribute`; no hay `innerHTML` con datos, ni `insertAdjacentHTML`, `eval` o URLs construidas con datos. El e2e `opponent.spec.ts` (nombre con HTML) pasa.
- **CSP.** El control de Playwright juega una mano completa (apuestas, draw con descarte, showdown) sin errores de consola ni violaciones de CSP. Los dos `style.setProperty` (`app.js:891`, `:1023`) usan CSSOM, que la CSP no bloquea.
- **Invitación por enlace:**
  - el token va en el fragmento (`#`) y se quita de la barra con `history.replaceState`;
  - la vista previa usa `POST` con el token en el cuerpo y responde 404 sin el token correcto;
  - la comparación del token es en tiempo constante (`sameToken`);
  - `linkInvitation` solo llega a quien creó la partida mientras espera rival;
  - el creador no puede unirse a su propio enlace;
  - un no invitado recibe siempre 403.
  
  Cubierto por `linkInvitations.test.ts` y `e2e/linkInvite.spec.ts`.
- **Varias mesas.** Cada mesa tiene su long-poll, su generación (un bucle viejo se detiene solo al pausar o cerrar) y su `AbortController`. Con la pestaña oculta no se consulta y al volver hay lectura inmediata. Nunca se pinta una versión más vieja. Ante un 429 se respeta `retryAfterMs`. `e2e/multiTable.spec.ts` y `e2e/realtime.spec.ts` pasan.
- **Correcciones visibles en el cliente.** El resultado de la mano nombra al ganador, distingue el retiro por tiempo y aparece también en la mano que cierra la partida (AUD-13, `e2e/handResult.spec.ts`). Se muestra cuántas cartas cambió el rival (AUD-08). El token se renueva 5 min antes de vencer (AUD-14). El abono de admin reutiliza la `Idempotency-Key` por intención (AUD-20).
- **Accesibilidad.** Las hojas modales atrapan el foco y dejan el fondo `inert`; hay región viva para avisos y aviso de 10 s antes del timeout. `e2e/accessibility.spec.ts` pasa.

### 7.4 No verificado

- Navegadores distintos de Chromium (Safari/WebKit y Firefox): el e2e solo usa Chromium (escritorio y Pixel 7).
- R2-01 en Firefox y Safari con varias pestañas: en Chromium, 4 pestañas del mismo perfil no lo disparan; no se comprobó si otros navegadores serializan igual los GET idénticos.
- La renovación del token con el equipo suspendido más de 1 h: por diseño, el token vence y hay que volver a entrar.

### 7.5 Estado de las correcciones (2026-10-15)

Todos los hallazgos de la re-auditoría están corregidos. Sus reproducciones pasaron a la suite permanente y se borraron de `test/audit/` (ahí siguen el fuzz y las propiedades del motor). Verificación: `npm run lint` y `npm run typecheck` en verde; `npm test` **207/207**; `npm run test:audit` 5/5; E2E **51 pasan** (escritorio y móvil; los 11 de `robustness.spec.ts` se omiten en móvil a propósito), 6,5 min.

| ID | Resolución | Regresión |
| --- | --- | --- |
| R2-01 | **Servidor:** pasado el tope de esperas, si la partida ya cambió se entrega la vista nueva y si no, `429` con `retryAfterMs` de 3 s (`EXCESS_WAIT_RETRY_MS`, `src/api/routes/matches.ts`). **Cliente:** un long-poll que vuelve en menos de 1 s y sin novedades no se repite al instante (`MIN_LONG_POLL_MS`, `Table.pollLoop`). | `test/integration/rateLimits.test.ts` (tope → 429; con novedades → 200; una espera de más no deja sin lecturas a las demás: 1 petición en vez de ~237); `e2e/robustness.spec.ts` (4 navegadores: menos de 30 long-polls en 10 s y los 4 ven la jugada) |
| R2-02 | `api()` acepta una `idempotencyKey` por intención. «Invitar» y «Crear partida con enlace» se desactivan durante la petición y reusan la clave si se reintenta el mismo formulario; «Jugar» igual, con una clave por partida. La clave solo se descarta ante un 4xx. | `e2e/robustness.spec.ts` (doble clic: 1 `POST`, 300 fichas bloqueadas, 1 partida; 1 unión y ningún aviso de error) |
| R2-03 | `readJson()` en `app.js` y `admin.js`: solo se parsea un cuerpo con `content-type` JSON; otra cosa da "El servidor no responde ahora mismo. Reintenta en unos segundos.". En `admin.js` la clave de un abono solo se descarta ante un 4xx, para que un reintento tras un 5xx no acredite dos veces. | `e2e/robustness.spec.ts` (502 en HTML) |
| R2-04 | `render()` vacía la selección de descarte cuando no es tu DRAW o cambia la mano. | `e2e/robustness.spec.ts` (con turnos vencidos y en el flujo normal) |
| R2-05 | El resultado de la mano usa `finishReason`: "Perdiste por inactividad" / "Ganaste la mano · X se desconectó". | `e2e/robustness.spec.ts` |
| R2-06 | `requestRematch` comprueba que la mesa siga abierta y, si no, avisa que la revancha está en «Tus partidas»; `replaceTable` ignora una mesa que ya no existe. | `e2e/robustness.spec.ts` |
| R2-07 | El formulario de partida es `novalidate` y `createMatchFromForm` valida para los dos botones: abre «Reglas» y muestra el aviso del campo inválido sin enviar nada. | `e2e/robustness.spec.ts` |
| R2-08 | Reproducciones en `npm test` y en el E2E (`e2e/robustness.spec.ts`, solo escritorio: es lógica del cliente), más las pruebas nuevas de R2-05, R2-06 y R2-07 y un control de CSP sobre una mano completa. | — |

README actualizado: comportamiento del tope de long-polls, comandos del cliente (doble clic, `Idempotency-Key` por intención, errores no JSON) y el tamaño real del cliente comprimido (~101 KB → ~29 KB con brotli; decía `app.js` 29 KB → 7 KB).

---

## 8. Re-auditoría del rediseño del cliente (2026-10-15)

**Alcance.** El PR #9 de LuisPortugal05, «Rediseño del cliente web: mesa de casino, cartas de verdad y fichas» (`2c31ab2`, fusionado en `ac89f66`): `public/styles.css` (+1293 líneas), `public/index.html` y `public/app.js`. Se integró en `main` con las correcciones de la sección 7 encima (avance rápido de `main` y reaplicación de los cambios; sin conflictos).

**Qué se revisó.**
- **Lógica nueva de `app.js`:** cartas con índices en dos esquinas, avatar con la inicial, clic para cerrar el resultado y clases nuevas en los botones.
- **Marcado nuevo:** el abanico decorativo del login y las placas de los asientos.
- **CSS:**
  - recursos externos;
  - `prefers-reduced-motion` y `prefers-contrast`;
  - foco visible;
  - capas y superposiciones.
- **Capturas y contraste medido** (Playwright, escritorio 1280×720 y Pixel 7): login, lobby, mesa antes del draw, mesa en DRAW, resultado de la mano y hoja de abandono.

**Sin defectos:**
- todo el texto nuevo se pinta con `textContent`;
- no carga fuentes, scripts ni imágenes externas: la única textura es un SVG en `data:`, que la CSP permite (`img-src 'self' data:`);
- la CSP no registra violaciones en una mano completa (control de `e2e/robustness.spec.ts`);
- las animaciones infinitas se detienen con `prefers-reduced-motion`;
- no hay desborde horizontal ni en escritorio ni en móvil;
- todo texto sobre fondo sólido supera 4,5:1 (las cartas y los botones dorados usan gradientes: oscuro sobre marfil u oro, con contraste de sobra);
- se conservan los IDs, clases y textos que usa el E2E.

### 8.1 Hallazgos

| ID | Severidad | Área | Título | Estado | Ubicación |
| --- | --- | --- | --- | --- | --- |
| R3-01 | Baja | Cliente / juego | El resultado de la mano flota 6–9 s sobre la mesa y tapa tus cartas nuevas, también cuando ya te toca actuar; no se cierra con teclado | CONFIRMADO (medido y capturado) · **corregido** | `public/styles.css:2001`, `public/app.js:874` |
| R3-02 | Info | Accesibilidad | El texto de ejemplo de los campos (`--tertiary`) tenía 3,85:1 de contraste (WCAG 1.4.3 pide 4,5:1) | CONFIRMADO (medido) · **corregido** | `public/styles.css:52` |
| R3-03 | Info | Cliente | La inicial del avatar cortaba los emojis por la mitad (`charAt(0)` toma una unidad UTF-16) | SOSPECHA (código) · **corregido** | `public/app.js:272` |
| R3-04 | Info | Diseño | En escritorio de poca altura (1280×720), con tu turno activo, la barra de acciones fija tapa tu placa (tus fichas y tu apuesta); hay que hacer scroll | CONFIRMADO (medido) · pendiente del diseñador | `public/styles.css:1360-1362` |

**R3-01.**
- **Medición:** a 1280×720, el resultado ocupaba y = 320–565 px, encima de las 5 cartas nuevas, que empiezan en y = 474 px; en el móvil las tapaba por completo. Quien actúa primero en la mano siguiente decidía sin ver sus cartas durante hasta 9 s (los turnos pueden ser de 15 s), salvo tocando el aviso para cerrarlo.
- **Corrección:** si te toca actuar, el resultado se muestra en una sola línea, sin las manos reveladas, y no tapa tus cartas (y = 405–451 px frente a 474 px). Escape lo cierra. Mientras esperas se mantiene el diseño completo, con las dos manos.
- **Regresión:** `e2e/robustness.spec.ts`, prueba «R3-01».

**R3-02.**
- **Corrección:** `--tertiary` pasa de `#6d7269` a `#80857b` (≈ 5:1). Solo lo usan el texto de ejemplo de los campos y el borde de la flecha de «Reglas».
- **Regresión:** «R3-02», que mide el contraste real del texto de ejemplo.

**R3-03.**
- **Corrección:** la inicial se toma por puntos de código.
- **Regresión:** «R3-03», con un jugador cuyo nombre empieza con «🂡».

**R3-04.**
- **Medición:** la barra de acciones es `position: sticky; bottom: 0` y mide ~150 px con el control de subida. A 1280×720 ocupa y = 571–720 px y tu placa queda en y = 582–630 px, así que se ve solo al hacer scroll. Las cartas quedan libres por 1 px. En el móvil (Pixel 7) la placa queda visible.
- **Recomendación** (se deja al diseñador porque cambia la maquetación): con `@media (max-height: 760px)`, reducir la altura del paño o poner la placa al lado de las cartas en lugar de debajo.

### 8.2 Verificación

- `npm run lint` y `npm run typecheck`: en verde.
- `npm test`: 207/207.
- `npm run test:audit`: 5/5.
- E2E: **54 pasan** y 14 se omiten (los de `robustness.spec.ts` en móvil, a propósito); 8,2 min, código de salida 0.

En una corrida intermedia, `linkInvite.spec.ts` se quedó congelado ~8 min y agotó su tiempo. Repetido aislado pasó 3 de 3 en ~9 s cada vez, así que no se atribuye al rediseño (probable suspensión del equipo durante la corrida).
