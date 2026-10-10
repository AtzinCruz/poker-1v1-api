// Cliente web mínimo: consume la API REST del mismo origen. Sin framework, sin build step.
// El estado de sesión vive en sessionStorage (por pestaña) para poder abrir dos pestañas
// distintas y jugar contra uno mismo durante el desarrollo.
//
// Mesas: se pueden jugar hasta MAX_TABLES partidas a la vez, en pantalla dividida. Cada mesa es una
// instancia de `Table` con su propio long-poll, su estado y su DOM (clonado de #table-template).

const SESSION_KEY = "poker_session_v1";
const OPEN_TABLES_KEY = "poker_open_tables_v1";
const LEGACY_LAST_MATCH_KEY = "poker_last_match_v1";
const MAX_TABLES = 4;
// El servidor sostiene cada GET ?since= hasta 25 s; el cliente corta a los 35 s por si la red se cuelga.
const LONG_POLL_CLIENT_TIMEOUT_MS = 35_000;
const POLL_RETRY_MS = 2000;
const COUNTDOWN_TICK_MS = 250;
const INVITATION_POLL_INTERVAL_MS = 3000;
const URGENT_SECONDS = 10;
const HAND_RESULT_MS = 6000;
const SHOWDOWN_RESULT_MS = 9000;
// El token de jugador dura poco (1 h): se renueva unos minutos antes de vencer.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// Mismas reglas que el servidor (src/domain/blinds.ts): solo para anticipar el incremento en el formulario.
const BLIND_INCREASE_PERCENT = 5;
const BLIND_LEVEL_HANDS = 3;

// El servidor manda las cartas como "AS", "KD", "10H": el rango puede ser letra o número.
const RANK_NAME = { J: "Jota", Q: "Reina", K: "Rey", A: "As" };
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAME = { S: "picas", H: "corazones", D: "diamantes", C: "tréboles" };
const PHASE_LABEL = {
  HAND_SETUP: "Repartiendo",
  BETTING_PRE_DRAW: "Apuestas",
  DRAW: "Descarte",
  BETTING_POST_DRAW: "Apuestas finales",
  SHOWDOWN: "Showdown",
  HAND_FINISHED: "Mano terminada",
};

let session = loadSession(); // { token, player: { id, displayName, fictionalBalance } }
/** Mesas abiertas, en el orden en que se muestran (un Map conserva el orden de inserción). */
const tables = new Map();
let countdownTimer = null;
let tokenRefreshTimer = null;
let invitationPollTimer = null;
let dismissedInvitationIds = new Set();
let invitationPopupVisible = false;
let toastTimer = null;
/** Mesa cuya partida se quiere abandonar mientras la hoja de confirmación está abierta. */
let resignTarget = null;

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const screens = {
  auth: el("screen-auth"),
  lobby: el("screen-lobby"),
  table: el("screen-table"),
};

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle("hidden", key !== name);
  }
  document.body.classList.toggle("multi-table", name === "table" && tables.size > 1);
  window.scrollTo({ top: 0 });
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(next) {
  session = next;
  if (next) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
  scheduleTokenRefresh();
}

/** Partidas abiertas en mesas de la sesión anterior de esta pestaña (o la última partida del formato viejo). */
function loadOpenTableIds() {
  try {
    const raw = sessionStorage.getItem(OPEN_TABLES_KEY);
    if (raw) return JSON.parse(raw).slice(0, MAX_TABLES);
    const legacy = sessionStorage.getItem(LEGACY_LAST_MATCH_KEY);
    sessionStorage.removeItem(LEGACY_LAST_MATCH_KEY);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

function saveOpenTableIds() {
  if (tables.size) {
    sessionStorage.setItem(OPEN_TABLES_KEY, JSON.stringify([...tables.keys()]));
  } else {
    sessionStorage.removeItem(OPEN_TABLES_KEY);
  }
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Error HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
    // 429: el servidor dice cuánto esperar (§8 "Esperar retryAfterMs").
    this.retryAfterMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
  }
}

async function api(method, path, { body, idempotent = false, timeoutMs, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (idempotent) headers["Idempotency-Key"] = crypto.randomUUID();

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: combineSignals(signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && session?.token && path !== "/v1/auth/session" && path !== "/v1/auth/password") {
      expireSession();
    }
    throw new ApiError(res.status, parsed);
  }
  return parsed;
}

function combineSignals(...signals) {
  const present = signals.filter(Boolean);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/** Mensaje para el usuario; en un 429, cuánto esperar. */
function errorMessage(err) {
  if (err.status === 429 && err.retryAfterMs !== null) {
    return `Demasiadas solicitudes seguidas. Espera ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} s y vuelve a intentarlo.`;
  }
  return err.message;
}

/** El token ya no sirve (vencido o revocado): limpiar la sesión y volver al login. */
function expireSession() {
  closeAllTables();
  stopInvitationPolling();
  saveSession(null);
  el("session-info").classList.add("hidden");
  showScreen("auth");
  showError("auth-error", "Tu sesión venció. Vuelve a entrar.");
}

// ---------- Renovación del token ----------
function tokenExpiresAt(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).exp * 1000;
  } catch {
    return null;
  }
}

/** Los tokens duran poco (§8.1): se piden uno nuevo antes de que venza el actual. */
function scheduleTokenRefresh() {
  clearTimeout(tokenRefreshTimer);
  tokenRefreshTimer = null;
  const expiresAt = session?.token ? tokenExpiresAt(session.token) : null;
  if (!expiresAt) return;
  tokenRefreshTimer = setTimeout(refreshToken, Math.max(5_000, expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS));
}

async function refreshToken() {
  try {
    saveSession(await api("POST", "/v1/auth/refresh"));
  } catch (err) {
    // 401: api() ya cerró la sesión. Otra cosa (red caída): reintentar en un rato.
    if (err.status !== 401) tokenRefreshTimer = setTimeout(refreshToken, 30_000);
  }
}

// ---------- Render helpers ----------
function parseCard(code) {
  return { suit: code.slice(-1), label: code.slice(0, -1) };
}

function cardName(code) {
  const { suit, label } = parseCard(code);
  return `${RANK_NAME[label] || label} de ${SUIT_NAME[suit] || suit}`;
}

function formatCard(code, faceDown = false) {
  const tile = document.createElement("div");
  tile.className = "card-tile" + (faceDown ? " face-down" : "");
  if (faceDown) {
    tile.setAttribute("aria-hidden", "true");
    return tile;
  }
  const { suit, label } = parseCard(code);
  if (suit === "H" || suit === "D") tile.classList.add("red");
  tile.setAttribute("role", "img");
  tile.setAttribute("aria-label", cardName(code));
  for (const text of [label, SUIT_SYMBOL[suit] || suit]) {
    const span = document.createElement("span");
    span.textContent = text;
    span.setAttribute("aria-hidden", "true");
    tile.appendChild(span);
  }
  return tile;
}

const fmt = (n) => Number(n).toLocaleString("es");

/** "+10", "−20" (signo menos tipográfico), "0". */
function signed(amount) {
  const abs = fmt(Math.abs(amount));
  return amount > 0 ? `+${abs}` : amount < 0 ? `−${abs}` : "0";
}

/** "300 fichas · ciegas 10/20" y, si suben, "(+15 cada 3 manos)". */
function rulesText(rules) {
  const rising = rules.blindIncrement ? ` (+${fmt(rules.blindIncrement)} cada ${rules.blindLevelHands} manos)` : "";
  return `${fmt(rules.startingStack)} fichas · ciegas ${rules.smallBlind}/${rules.bigBlind}${rising}`;
}

function setWalletDisplay(wallet) {
  el("wallet-available").textContent = fmt(wallet.available);
  el("wallet-blocked").textContent = fmt(wallet.blocked);
  el("wallet-blocked-wrap").classList.toggle("hidden", !wallet.blocked);
}

async function refreshWallet() {
  try {
    const wallet = await api("GET", "/v1/wallet");
    setWalletDisplay(wallet);
  } catch {
    // no bloquea la UI si falla
  }
}

function showToast(message, ms = 3200) {
  const toast = el("hand-result-banner");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), ms);
}

/** Región viva oculta: anuncia sin tocar el texto visible (que el polling reescribe). */
function announce(message) {
  const region = el("sr-announcer");
  region.textContent = "";
  setTimeout(() => (region.textContent = message), 50);
}

function makeButton(label, cls, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function showError(id, message) {
  const node = typeof id === "string" ? el(id) : id;
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideError(id) {
  (typeof id === "string" ? el(id) : id).classList.add("hidden");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function untilVisible() {
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

// ---------- Hojas modales ----------
// Hojas abiertas → elemento que tenía el foco antes de abrirlas (para devolverlo al cerrar).
const openSheets = new Map();
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/** Mientras haya una hoja abierta, lo de atrás queda `inert`: sin foco ni clics, como promete aria-modal. */
function setBackgroundInert(inert) {
  el("app").inert = inert;
  document.querySelector(".topbar").inert = inert;
}

function openSheet(id, focusTarget) {
  if (!openSheets.has(id)) openSheets.set(id, document.activeElement);
  el(id).classList.remove("hidden");
  setBackgroundInert(true);
  const target = typeof focusTarget === "string" ? el(focusTarget) : focusTarget;
  (target ?? el(id).querySelector(FOCUSABLE))?.focus();
}

function closeSheet(id) {
  if (!openSheets.has(id)) return;
  const returnFocus = openSheets.get(id);
  openSheets.delete(id);
  el(id).classList.add("hidden");
  if (openSheets.size === 0) setBackgroundInert(false);
  if (returnFocus?.isConnected) returnFocus.focus();
}

// Tab y Mayús+Tab circulan dentro de la hoja visible en vez de escaparse a la mesa.
document.addEventListener("keydown", (evt) => {
  if (evt.key !== "Tab") return;
  const sheet = document.querySelector(".sheet-overlay:not(.hidden) .sheet");
  if (!sheet) return;
  const items = [...sheet.querySelectorAll(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!sheet.contains(document.activeElement)) {
    evt.preventDefault();
    first.focus();
  } else if (evt.shiftKey && document.activeElement === first) {
    evt.preventDefault();
    last.focus();
  } else if (!evt.shiftKey && document.activeElement === last) {
    evt.preventDefault();
    first.focus();
  }
});

// Escape cierra la hoja visible; un toque fuera de la hoja también.
document.addEventListener("keydown", (evt) => {
  if (evt.key !== "Escape") return;
  if (!el("resign-popup").classList.contains("hidden")) closeSheet("resign-popup");
  else if (invitationPopupVisible) hideInvitationPopup();
});

for (const [overlayId, close] of [
  ["resign-popup", () => closeSheet("resign-popup")],
  ["invitation-popup", () => hideInvitationPopup()],
]) {
  el(overlayId).addEventListener("click", (evt) => {
    if (evt.target === evt.currentTarget) close();
  });
}

// ---------- Auth ----------
el("form-login").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("auth-error");
  const displayName = el("input-display-name").value.trim();
  const password = el("input-password").value;
  if (!displayName || !password) return;
  const submit = evt.submitter;
  submit.disabled = true;
  try {
    const result = await api("POST", "/v1/auth/session", { body: { displayName, password } });
    el("input-password").value = "";
    saveSession(result);
    afterLogin();
  } catch (err) {
    showError("auth-error", errorMessage(err));
  } finally {
    submit.disabled = false;
  }
});

el("form-change-password").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("password-error");
  el("password-ok").classList.add("hidden");
  try {
    const result = await api("POST", "/v1/auth/password", {
      body: { currentPassword: el("input-current-password").value, newPassword: el("input-new-password").value },
    });
    saveSession(result);
    el("form-change-password").reset();
    el("password-ok").classList.remove("hidden");
  } catch (err) {
    showError("password-error", errorMessage(err));
  }
});

el("btn-logout").addEventListener("click", () => {
  closeAllTables();
  stopInvitationPolling();
  saveSession(null);
  el("session-info").classList.add("hidden");
  showScreen("auth");
});

function afterLogin() {
  el("player-name").textContent = session.player.displayName;
  el("lobby-name").textContent = session.player.displayName;
  el("session-info").classList.remove("hidden");
  el("my-player-id").value = session.player.id;
  setWalletDisplay({ available: session.player.fictionalBalance, blocked: 0 });
  refreshWallet();
  const restored = loadOpenTableIds();
  if (restored.length) {
    for (const matchId of restored) addTable(matchId);
    showTables();
  } else {
    goToLobby();
  }
}

/** Vuelve al lobby y retoma el chequeo de invitaciones pendientes. Las mesas siguen abiertas, en pausa. */
function goToLobby() {
  for (const table of tables.values()) table.pause();
  stopCountdown();
  renderedMyMatchesKey = null; // al volver, pintar la lista aunque no haya cambiado
  renderOpenTablesButton();
  showScreen("lobby");
  refreshWallet();
  startInvitationPolling();
}

// ---------- Mesas ----------
/** Abre una mesa para la partida (o la deja como está si ya estaba abierta). false si no hay lugar. */
function addTable(matchId) {
  if (tables.has(matchId)) return true;
  if (tables.size >= MAX_TABLES) return false;
  const table = new Table(matchId);
  tables.set(matchId, table);
  el("tables").appendChild(table.root);
  saveOpenTableIds();
  layoutTables();
  return true;
}

/** Abre la partida en una mesa y muestra las mesas; avisa si ya hay MAX_TABLES abiertas. */
function openMatch(matchId) {
  if (!addTable(matchId)) {
    showToast(`Ya tienes ${MAX_TABLES} mesas abiertas: cierra una para abrir otra.`, 4500);
    return false;
  }
  showTables();
  tables.get(matchId).root.scrollIntoView({ block: "nearest" });
  return true;
}

function showTables() {
  stopInvitationPolling();
  hideInvitationPopup();
  showScreen("table");
  layoutTables();
  for (const table of tables.values()) table.resume();
  startCountdown();
}

function closeTable(matchId) {
  const table = tables.get(matchId);
  if (!table) return;
  table.destroy();
  tables.delete(matchId);
  saveOpenTableIds();
  if (tables.size === 0) {
    goToLobby();
  } else {
    layoutTables();
  }
}

function closeAllTables() {
  for (const table of tables.values()) table.destroy();
  tables.clear();
  saveOpenTableIds();
  stopCountdown();
}

/** La revancha ocupa el lugar de la mesa terminada, en la misma posición de la rejilla. */
function replaceTable(oldMatchId, newMatchId) {
  if (tables.has(newMatchId)) {
    closeTable(oldMatchId);
    return;
  }
  const old = tables.get(oldMatchId);
  const table = new Table(newMatchId);
  const entries = [...tables.entries()].map(([id, t]) => (id === oldMatchId ? [newMatchId, table] : [id, t]));
  old.root.replaceWith(table.root);
  old.destroy();
  tables.clear();
  for (const [id, t] of entries) tables.set(id, t);
  saveOpenTableIds();
  layoutTables();
  table.resume();
}

/** Rejilla según cuántas mesas hay (1: ancho normal; 2-4: pantalla dividida) y el resumen de turnos. */
function layoutTables() {
  const container = el("tables");
  container.dataset.count = String(tables.size);
  document.body.classList.toggle("multi-table", !screens.table.classList.contains("hidden") && tables.size > 1);
  el("btn-add-table").classList.toggle("hidden", tables.size >= MAX_TABLES);
  const yourTurn = [...tables.values()].filter((t) => t.isYourTurn()).length;
  const count = tables.size === 1 ? "1 mesa" : `${tables.size} mesas`;
  el("tables-summary").textContent =
    tables.size > 1 && yourTurn ? `${count} · tu turno en ${yourTurn}` : tables.size > 1 ? count : "";
  renderOpenTablesButton();
}

function renderOpenTablesButton() {
  const button = el("btn-open-tables");
  button.classList.toggle("hidden", tables.size === 0);
  button.textContent = tables.size === 1 ? "Volver a tu mesa" : `Volver a tus ${tables.size} mesas`;
}

el("btn-back-lobby").addEventListener("click", goToLobby);
el("btn-add-table").addEventListener("click", () => {
  goToLobby();
  el("input-invitee-id").focus();
});
el("btn-open-tables").addEventListener("click", showTables);

// Un solo reloj para los anillos de cuenta regresiva de todas las mesas.
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    for (const table of tables.values()) table.renderCountdown();
  }, COUNTDOWN_TICK_MS);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Cada mesa ve la pestaña oculta y espera a que vuelva: se liberan sus conexiones en el servidor.
    for (const table of tables.values()) table.inFlightPoll?.abort();
  } else if (invitationPollTimer) {
    lobbyTick(); // al volver al lobby, revisar enseguida
  }
});

class Table {
  constructor(matchId) {
    this.matchId = matchId;
    this.root = el("table-template").content.firstElementChild.cloneNode(true);
    this.root.dataset.matchId = matchId;
    this.view = null;
    // Cada resume/pause cambia la generación: un bucle de una generación vieja se detiene solo.
    this.generation = 0;
    this.running = false;
    this.inFlightPoll = null;
    this.selectedDiscardIndexes = new Set();
    // Duración observada del turno actual (la vista no trae cuánto duraba): alimenta el anillo.
    this.turnClock = { key: null, totalMs: 1, warned: null };
    this.renderedActionKey = null;
    this.renderedFinishedKey = null;
    this.renderedCardKeys = new Map();
    // null hasta la primera vista: lo que ya había terminado al abrir la mesa no se vuelve a anunciar.
    this.lastShownHandResult = null;
    this.resultTimer = null;

    this.q("btn-resign").addEventListener("click", () => {
      resignTarget = this;
      el("resign-text").textContent = `${this.opponentLabel()}: te vas con las fichas que te quedan; lo que ya apostaste en esta mano es para tu rival.`;
      openSheet("resign-popup", "btn-resign-cancel");
    });
    this.q("btn-close-table").addEventListener("click", () => closeTable(this.matchId));
  }

  /** Elemento de esta mesa con la clase dada. */
  q(cls) {
    return this.root.querySelector(`.${cls}`);
  }

  opponentLabel() {
    return this.view?.opponent?.displayName ? `Mesa contra ${this.view.opponent.displayName}` : "Esta mesa";
  }

  isYourTurn() {
    return Boolean(this.view?.turn && this.view.turn.playerId === session?.player.id);
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    void this.pollLoop(this.generation);
  }

  pause() {
    this.running = false;
    this.generation += 1;
    this.inFlightPoll?.abort();
  }

  destroy() {
    this.pause();
    clearTimeout(this.resultTimer);
    this.root.remove();
    if (resignTarget === this) resignTarget = null;
  }

  /**
   * Una petición a la vez. La primera lectura es inmediata; después, long-poll con la versión que ya
   * tenemos: el servidor responde cuando la partida cambia. Con la pestaña oculta no se consulta nada.
   */
  async pollLoop(generation) {
    let since;
    while (generation === this.generation) {
      if (document.hidden) {
        await untilVisible();
        since = undefined; // al volver, lectura inmediata: pudo pasar de todo
        continue;
      }
      const retryInMs = await this.pollOnce(since, generation);
      if (retryInMs > 0) await sleep(retryInMs); // red caída, 503 o 429: reintentar sin martillar
      // Una partida cancelada ya no cambia: deja de escuchar.
      if (this.view?.status === "CANCELLED") return;
      since = this.view?.stateVersion;
    }
  }

  /** Lee la partida (con `since`, como long-poll). Devuelve cuánto esperar antes de reintentar (0 si fue bien). */
  async pollOnce(since, generation = this.generation) {
    try {
      const query = since !== undefined ? `?since=${since}` : "";
      const controller = new AbortController();
      if (since !== undefined) this.inFlightPoll = controller;
      let view;
      try {
        view = await api("GET", `/v1/matches/${this.matchId}${query}`, {
          timeoutMs: LONG_POLL_CLIENT_TIMEOUT_MS,
          signal: controller.signal,
        });
      } finally {
        if (this.inFlightPoll === controller) this.inFlightPoll = null;
      }
      if (generation !== this.generation) return 0; // la mesa se pausó o cerró mientras esperaba
      // El long-poll y la lectura tras una jugada pueden cruzarse: nunca pintar un estado más viejo.
      if (this.view && view.stateVersion < this.view.stateVersion) return 0;
      this.render(view);
      return 0;
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        closeTable(this.matchId);
        showToast("Esa partida ya no está disponible.");
        return 0;
      }
      // Abortado a propósito al ocultar la pestaña o pausar la mesa: no es un error.
      if (err.name === "AbortError" && (document.hidden || generation !== this.generation)) return 0;
      // Un fallo del propio cliente (no de la red ni de la API) no debe quedar oculto tras el reintento.
      if (!(err instanceof ApiError) && err.name !== "AbortError" && err.name !== "TimeoutError" && err.name !== "TypeError") {
        console.error("Error al pintar la mesa", err);
      }
      if (err.status === 429 && err.retryAfterMs !== null) return err.retryAfterMs;
      return POLL_RETRY_MS;
    }
  }

  render(view) {
    const previous = this.view;
    this.view = view;
    const finished = view.status === "MATCH_FINISHED" || view.status === "CANCELLED";
    const waiting = view.status === "WAITING_FOR_OPPONENT";
    const opponentName = view.opponent?.displayName || "Rival";

    this.root.setAttribute("aria-label", view.opponent?.displayName ? `Mesa contra ${opponentName}` : "Mesa");
    this.q("match-hand").textContent = view.handNumber ? `Mano ${view.handNumber}` : "Mesa";
    this.q("match-status-line").textContent = waiting
      ? "Esperando a tu rival"
      : finished
        ? "Partida terminada"
        : PHASE_LABEL[view.phase] || "";
    this.q("blinds-line").textContent = finished || waiting ? "" : blindsText(view);

    const table = this.q("table");
    table.classList.toggle("is-waiting", waiting);
    // Terminada: las fichas ya se repartieron; el pozo y las apuestas de la última mano solo confunden.
    table.classList.toggle("is-finished", view.status === "MATCH_FINISHED");
    this.q("pot-amount").textContent = fmt(view.pot);

    this.q("you-stack").textContent = waiting ? "–" : fmt(view.you.stack);
    this.setBetChip("you", view.you.contribution);

    this.q("opponent-name").textContent = opponentName;
    this.q("opponent-panel").setAttribute("aria-label", opponentName);
    this.q("result-opponent-name").textContent = opponentName;

    if (view.opponent) {
      this.q("opponent-stack").textContent = fmt(view.opponent.stack);
      this.setBetChip("opponent", view.opponent.contribution);
      if (view.opponent.cards) {
        this.renderCards("opponent-cards", view.opponent.cards);
      } else {
        this.renderFaceDown("opponent-cards", view.opponent.cardCount);
      }
    } else {
      this.q("opponent-stack").textContent = "–";
      this.setBetChip("opponent", 0);
      this.q("opponent-cards").innerHTML = "";
      this.renderedCardKeys.delete("opponent-cards");
    }
    this.renderOpponentDraw(view, previous);

    this.renderCards("you-cards", view.you.cards);

    const isYourTurn = this.isYourTurn();
    this.root.classList.toggle("your-turn", isYourTurn && !finished);
    this.q("you-panel").classList.toggle("active-turn", isYourTurn);
    this.q("opponent-panel").classList.toggle("active-turn", Boolean(view.turn && !isYourTurn));
    this.q("turn-indicator").textContent = view.turn ? (isYourTurn ? "Tu turno" : `Turno de ${opponentName}`) : "";

    this.renderActionPanel(view, isYourTurn);
    this.renderCountdown();

    this.q("btn-resign").classList.toggle("hidden", view.status !== "IN_PROGRESS" && view.status !== "WAITING_FOR_OPPONENT");

    // Resultado de la mano recién terminada, también la que cerró la partida (AUD-13).
    const lastHand = view.lastHand;
    if (this.lastShownHandResult === null) {
      this.lastShownHandResult = lastHand?.number ?? 0;
    } else if (lastHand && lastHand.number > this.lastShownHandResult) {
      this.lastShownHandResult = lastHand.number;
      this.showHandResult(lastHand, view);
    }

    if (finished) {
      this.renderFinished(view);
      if (previous && previous.status !== view.status) refreshWallet();
    }
    layoutTables();
  }

  setBetChip(who, amount) {
    this.q(`${who}-contribution`).textContent = amount ? fmt(amount) : "0";
    this.q(`${who}-bet`).classList.toggle("empty", !amount);
  }

  /** Cuántas cartas cambió el rival en esta mano (público, como en una mesa real). */
  renderOpponentDraw(view, previous) {
    const note = this.q("opponent-draw");
    const count = view.opponent?.discardedCount;
    const show = view.status === "IN_PROGRESS" && count !== null && count !== undefined;
    note.classList.toggle("hidden", !show);
    if (!show) return;
    note.textContent = count === 0 ? "Se plantó" : `Cambió ${count} ${count === 1 ? "carta" : "cartas"}`;
    const changed = previous?.handNumber !== view.handNumber || previous?.opponent?.discardedCount !== count;
    if (changed && previous) announce(`${view.opponent.displayName || "Tu rival"} ${count === 0 ? "se plantó" : `cambió ${count} ${count === 1 ? "carta" : "cartas"}`}.`);
  }

  /** Quién ganó la mano y cuánto, en la propia mesa (con varias mesas, un aviso global no dice de cuál). */
  showHandResult(lastHand, view) {
    const me = session.player.id;
    const rival = view.opponent?.displayName || "Tu rival";
    const youWon = lastHand.winnerId === me;
    const net = `${signed(lastHand.net)} fichas`;
    let text;
    if (lastHand.winReason === "SHOWDOWN") {
      text = `${youWon ? "Ganaste la mano" : `Ganó ${rival}`} · ${net} · pozo de ${fmt(lastHand.pot)}`;
    } else if (lastHand.winReason === "SPLIT") {
      text = `Empate · pozo de ${fmt(lastHand.pot)} a medias · ${net}`;
    } else if (lastHand.winReason === "FORFEIT") {
      text = youWon ? `Ganaste la mano · ${rival} abandonó · ${net}` : `Abandonaste · ${net}`;
    } else {
      const youFolded = lastHand.folderId === me;
      const why = lastHand.timedOut ? (youFolded ? " (se te acabó el tiempo)" : " (se le acabó el tiempo)") : "";
      text = youFolded ? `Ganó ${rival} · te retiraste${why} · ${net}` : `Ganaste la mano · ${rival} se retiró${why} · ${net}`;
    }

    const box = this.q("hand-result");
    this.q("hand-result-text").textContent = text;
    const hands = this.q("hand-result-hands");
    const revealed = lastHand.revealedCards;
    hands.classList.toggle("hidden", !revealed);
    for (const [cls, cards] of [["result-you-cards", revealed?.you], ["result-opponent-cards", revealed?.opponent]]) {
      const container = this.q(cls);
      container.innerHTML = "";
      (cards || []).forEach((code) => container.appendChild(formatCard(code)));
    }
    box.classList.remove("hidden");
    box.classList.toggle("won", youWon);
    announce(tables.size > 1 ? `${this.opponentLabel()}: ${text}` : text);
    clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => box.classList.add("hidden"), revealed ? SHOWDOWN_RESULT_MS : HAND_RESULT_MS);
  }

  /** Vuelve a pintar las cartas solo si cambiaron, así la animación de reparto no se repite en cada poll. */
  renderCards(cls, cards) {
    const view = this.view;
    const container = this.q(cls);
    const isDrawSelectable = cls === "you-cards" && view.phase === "DRAW" && this.isYourTurn();

    const selection = isDrawSelectable ? [...this.selectedDiscardIndexes].sort().join(",") : "-";
    const key = `${view.handNumber}|${cards.join(",")}|${selection}`;
    if (this.renderedCardKeys.get(cls) === key) return;
    const isNewHand = !this.renderedCardKeys.get(cls)?.startsWith(`${view.handNumber}|${cards.join(",")}|`);
    this.renderedCardKeys.set(cls, key);
    // La animación de reparto solo corre cuando llegan cartas nuevas, no al marcar una para descartar.
    container.classList.toggle("settled", !isNewHand);
    container.innerHTML = "";

    cards.forEach((code, index) => {
      const tile = formatCard(code);
      if (isDrawSelectable) {
        const selected = this.selectedDiscardIndexes.has(index);
        tile.classList.add("selectable");
        tile.classList.toggle("selected", selected);
        tile.setAttribute("role", "button");
        tile.setAttribute("tabindex", "0");
        tile.setAttribute("aria-pressed", String(selected));
        tile.setAttribute("aria-label", `${cardName(code)}${selected ? ", se descarta" : ""}`);
        const toggle = () => {
          if (this.selectedDiscardIndexes.has(index)) {
            this.selectedDiscardIndexes.delete(index);
          } else {
            this.selectedDiscardIndexes.add(index);
          }
          this.renderCards(cls, cards);
          this.renderActionPanel(view, true);
          container.children[index]?.focus();
        };
        tile.addEventListener("click", toggle);
        tile.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" || evt.key === " ") {
            evt.preventDefault();
            toggle();
          }
        });
      }
      container.appendChild(tile);
    });
  }

  renderFaceDown(cls, count) {
    const container = this.q(cls);
    const key = `down|${this.view?.handNumber}|${count}`;
    if (this.renderedCardKeys.get(cls) === key) return;
    this.renderedCardKeys.set(cls, key);
    container.classList.remove("settled");
    container.innerHTML = "";
    for (let i = 0; i < (count || 0); i++) {
      container.appendChild(formatCard("??", true));
    }
  }

  /** Anillo de cuenta regresiva. La duración total se toma del primer valor visto para ese turno. */
  renderCountdown() {
    const timer = this.q("turn-timer");
    const view = this.view;
    if (!view?.turn) {
      timer.classList.add("idle");
      return;
    }
    const msLeft = Math.max(0, new Date(view.turn.expiresAt).getTime() - Date.now());
    const key = `${view.turn.playerId}|${view.turn.expiresAt}`;
    if (this.turnClock.key !== key) this.turnClock = { key, totalMs: Math.max(msLeft, 1), warned: null };

    const seconds = Math.ceil(msLeft / 1000);
    timer.classList.remove("idle");
    timer.classList.toggle("urgent", seconds <= URGENT_SECONDS);
    timer.style.setProperty("--progress", String(Math.min(1, msLeft / this.turnClock.totalMs)));
    this.q("turn-seconds").textContent = String(seconds);

    // El anillo es aria-hidden: un solo aviso por turno para lectores de pantalla antes del fold automático.
    if (this.isYourTurn() && seconds <= URGENT_SECONDS && seconds > 0 && this.turnClock.warned !== key) {
      this.turnClock.warned = key;
      const message = `Quedan ${seconds} segundos para actuar.`;
      announce(tables.size > 1 ? `${this.opponentLabel()}: ${message}` : message);
    }
  }

  showHint(text) {
    const hint = this.q("action-hint");
    hint.textContent = text;
    hint.classList.remove("hidden");
  }

  renderActionPanel(view, isYourTurn) {
    const key = `${view.status}|${view.stateVersion}|${isYourTurn}|${[...this.selectedDiscardIndexes].sort().join(",")}`;
    if (this.renderedActionKey === key) return;
    this.renderedActionKey = key;
    if (view.status === "MATCH_FINISHED" || view.status === "CANCELLED") return; // renderFinished se ocupa
    const panel = this.q("action-panel");
    panel.innerHTML = "";
    this.q("action-hint").classList.add("hidden");
    hideError(this.q("action-error"));

    if (view.status === "WAITING_FOR_OPPONENT") {
      const p = document.createElement("p");
      p.className = "waiting";
      p.textContent = "Invitación enviada. La mesa empieza en cuanto tu rival la acepte.";
      panel.appendChild(p);
      return;
    }
    if (!isYourTurn || !view.legalActions?.length) {
      const p = document.createElement("p");
      p.className = "waiting";
      p.textContent = view.turn ? "Esperando al rival…" : "Esperando…";
      panel.appendChild(p);
      return;
    }

    const byType = Object.fromEntries(view.legalActions.map((a) => [a.type, a]));

    if (byType.DRAW) {
      const n = this.selectedDiscardIndexes.size;
      this.showHint(n === 0 ? "Toca las cartas que quieras cambiar." : `${n} ${n === 1 ? "carta marcada" : "cartas marcadas"} para cambiar.`);
      panel.appendChild(
        makeButton(n === 0 ? "Quedarme con estas" : `Cambiar ${n}`, "btn-primary", () =>
          this.submitAction({ type: "DRAW", discardedIndexes: [...this.selectedDiscardIndexes] }),
        ),
      );
      return;
    }

    // Orden fijo, de menor a mayor compromiso: retirarse · pasar/igualar · all-in · subir.
    if (byType.FOLD) panel.appendChild(makeButton("Retirarse", "btn-gray", () => this.submitAction({ type: "FOLD" })));
    if (byType.CHECK) panel.appendChild(makeButton("Pasar", "btn-tinted", () => this.submitAction({ type: "BET", amount: 0 })));
    if (byType.CALL) {
      panel.appendChild(
        makeButton(`Igualar ${fmt(byType.CALL.amount)}`, "btn-tinted", () => this.submitAction({ type: "BET", amount: byType.CALL.amount })),
      );
    }
    if (byType.ALL_IN) panel.appendChild(makeButton("All-in", "btn-gray", () => this.submitAction({ type: "ALL_IN" })));
    if (byType.RAISE) panel.appendChild(this.makeRaiseControl(byType.RAISE.min, byType.RAISE.max));
  }

  /** Slider + valor en vivo + botón: un solo gesto para elegir y confirmar la subida. */
  makeRaiseControl(min, max) {
    const wrap = document.createElement("div");
    wrap.className = "raise-control";

    const range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = "1";
    range.value = String(min);
    range.setAttribute("aria-label", "Cantidad a subir");

    const value = document.createElement("span");
    value.className = "raise-value";

    const btn = makeButton("", "btn-primary", () => this.submitAction({ type: "BET", amount: Number(range.value) }));

    const sync = () => {
      const amount = Number(range.value);
      value.textContent = fmt(amount);
      btn.textContent = amount === max ? "Subir todo" : "Subir";
      const pct = max === min ? 100 : ((amount - min) / (max - min)) * 100;
      range.style.setProperty("--fill-pct", `${pct}%`);
    };
    range.addEventListener("input", sync);
    sync();

    wrap.append(range, value, btn);
    return wrap;
  }

  async submitAction(payload) {
    const error = this.q("action-error");
    hideError(error);
    const buttons = this.q("action-panel").querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      await api("POST", `/v1/matches/${this.matchId}/actions`, {
        body: { ...payload, actionVersion: this.view.stateVersion },
        idempotent: true,
      });
      this.selectedDiscardIndexes = new Set();
      await this.pollOnce();
    } catch (err) {
      if (err.code === "STALE_STATE") {
        await this.pollOnce();
        showError(error, "La mesa cambió. Revisa y vuelve a intentarlo.");
      } else {
        buttons.forEach((b) => (b.disabled = false));
        showError(error, errorMessage(err));
        this.renderedActionKey = null;
      }
    }
  }

  async resign() {
    try {
      await api("POST", `/v1/matches/${this.matchId}/resign`, { idempotent: true });
      await this.pollOnce();
    } catch (err) {
      showError(this.q("action-error"), errorMessage(err));
    }
  }

  renderFinished(view) {
    // Solo redibujar si cambió algo (resultado u oferta de revancha): el long-poll despierta cada 25 s.
    const key = JSON.stringify([view.id, view.status, view.winnerId, view.finishReason, view.rematch, tables.size > 1]);
    if (key === this.renderedFinishedKey) return;
    const previous = this.renderedFinishedKey ? JSON.parse(this.renderedFinishedKey)[4] : undefined;
    this.renderedFinishedKey = key;

    const panel = this.q("action-panel");
    panel.innerHTML = "";
    this.q("action-hint").classList.add("hidden");
    const wrap = document.createElement("div");
    wrap.className = "finished";

    const title = document.createElement("p");
    title.className = "title";
    const detail = document.createElement("p");
    detail.className = "footnote";

    if (view.winnerId) {
      title.textContent = view.winnerId === session.player.id ? "Ganaste la partida" : "Perdiste la partida";
      detail.textContent =
        {
          RESIGN: "Por abandono.",
          DISCONNECT_TIMEOUT: "Por inactividad.",
          INSUFFICIENT_STACK: "Un jugador se quedó sin fichas para la ciega grande.",
        }[view.finishReason] || "";
    } else {
      title.textContent = "Partida cancelada";
      detail.textContent = "Tus fichas reservadas volvieron a tu saldo.";
    }

    wrap.append(title, detail);
    if (view.status === "MATCH_FINISHED") {
      wrap.appendChild(this.makeRematchSection(view, previous));
    } else {
      wrap.appendChild(makeButton(tables.size > 1 ? "Cerrar mesa" : "Nueva partida", "btn-primary", () => closeTable(this.matchId)));
    }
    panel.appendChild(wrap);
  }

  /** Oferta, espera o acceso a la revancha según su estado; siempre con salida para cerrar la mesa. */
  makeRematchSection(view, previousRematch) {
    const section = document.createElement("div");
    section.className = "rematch";
    const rival = view.opponent?.displayName || "Tu rival";
    const rematch = view.rematch && view.rematch.status !== "CANCELLED" ? view.rematch : null;

    const status = document.createElement("p");
    status.className = "rematch-status";
    const rules = document.createElement("p");
    rules.className = "footnote";
    rules.textContent = `Mismas reglas: ${rulesText(view.rules)} · ${view.rules.turnTimeoutSeconds} s`;
    const actions = document.createElement("div");
    actions.className = "rematch-actions";
    const close = makeButton(tables.size > 1 ? "Cerrar mesa" : "Volver al lobby", "btn-gray", () => closeTable(this.matchId));

    if (!rematch) {
      status.textContent = view.rematch?.status === "CANCELLED" ? "La revancha se canceló." : "¿Otra partida?";
      actions.append(close, makeButton("Revancha", "btn-primary", () => this.requestRematch()));
    } else if (rematch.status === "WAITING_FOR_OPPONENT" && !rematch.requestedByYou) {
      status.textContent = `${rival} quiere la revancha.`;
      actions.append(close, makeButton("Aceptar revancha", "btn-primary", () => this.requestRematch()));
      if (previousRematch?.matchId !== rematch.matchId) announce(`${rival} quiere la revancha.`);
    } else if (rematch.status === "WAITING_FOR_OPPONENT") {
      status.textContent = `Esperando a que ${rival} acepte la revancha.`;
      actions.append(close, makeButton("Ir a la revancha", "btn-tinted", () => replaceTable(this.matchId, rematch.matchId)));
    } else {
      status.textContent = "La revancha ya empezó.";
      actions.append(close, makeButton("Ir a la revancha", "btn-primary", () => replaceTable(this.matchId, rematch.matchId)));
    }
    section.append(status, rules, actions);
    return section;
  }

  /** Pide (o acepta, si el rival ya la pidió) la revancha; la mesa nueva ocupa el lugar de esta. */
  async requestRematch() {
    const error = this.q("action-error");
    hideError(error);
    const buttons = this.q("action-panel").querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const match = await api("POST", `/v1/matches/${this.matchId}/rematch`, { idempotent: true });
      refreshWallet();
      replaceTable(this.matchId, match.id);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      const entry = this.view?.rules?.startingStack !== undefined ? fmt(this.view.rules.startingStack) : "?";
      showError(error, err.code === "INSUFFICIENT_STACK" ? `No tienes saldo suficiente: la entrada es de ${entry} fichas.` : errorMessage(err));
    }
  }
}

/** "Ciegas 25/35 · suben en la mano 7" o "Ciegas 10/20". */
function blindsText(view) {
  const b = view.blinds;
  if (!b) return "";
  return `Ciegas ${fmt(b.small)}/${fmt(b.big)}${b.nextIncreaseAtHand ? ` · suben en la mano ${b.nextIncreaseAtHand}` : ""}`;
}

// Confirmación de abandono: una sola hoja para todas las mesas; sabe de cuál se abrió.
el("btn-resign-cancel").addEventListener("click", () => closeSheet("resign-popup"));
el("btn-resign-confirm").addEventListener("click", async () => {
  const table = resignTarget;
  resignTarget = null;
  closeSheet("resign-popup");
  if (table && tables.get(table.matchId) === table) await table.resign();
});

// ---------- Invitaciones pendientes ----------
/** Lo que el lobby refresca periódicamente: invitaciones recibidas y tus partidas abiertas. */
function lobbyTick() {
  pollInvitations();
  refreshMyMatches();
  // Si el rival abandona mientras estás aquí, el saldo de arriba debe reflejar lo que ganaste.
  if (!document.hidden) refreshWallet();
}

function startInvitationPolling() {
  stopInvitationPolling();
  lobbyTick();
  invitationPollTimer = setInterval(lobbyTick, INVITATION_POLL_INTERVAL_MS);
}

function stopInvitationPolling() {
  if (invitationPollTimer) clearInterval(invitationPollTimer);
  invitationPollTimer = null;
}

async function pollInvitations() {
  if (document.hidden) return; // pestaña oculta: nadie va a ver la invitación
  try {
    const invitations = await api("GET", "/v1/invitations");
    const pending = invitations.filter((inv) => !dismissedInvitationIds.has(inv.matchId));
    if (pending.length > 0) {
      renderInvitationPopup(pending);
    } else if (invitationPopupVisible) {
      hideInvitationPopup();
    }
  } catch {
    // no bloquea el lobby si falla
  }
}

let renderedInvitationKey = null;

function renderInvitationPopup(invitations) {
  // Redibujar solo si cambió el conjunto: cada poll (3 s) borraba la lista y el foco de teclado con ella.
  const key = invitations.map((inv) => inv.matchId).join(",");
  if (invitationPopupVisible && key === renderedInvitationKey) return;
  renderedInvitationKey = key;
  const list = el("invitation-list");
  list.innerHTML = "";
  for (const inv of invitations) {
    const item = document.createElement("div");
    item.className = "invitation-item";

    const who = document.createElement("p");
    who.className = "headline";
    who.textContent = inv.creatorDisplayName;
    item.appendChild(who);

    const rules = document.createElement("p");
    rules.className = "invitation-rules";
    rules.textContent = rulesText(inv.rules);
    item.appendChild(rules);

    const actions = document.createElement("div");
    actions.className = "invitation-actions";
    actions.appendChild(
      makeButton("Ignorar", "btn-gray", () => {
        dismissedInvitationIds.add(inv.matchId);
        pollInvitations();
      }),
    );
    actions.appendChild(makeButton("Jugar", "btn-primary", () => acceptInvitation(inv)));
    item.appendChild(actions);
    list.appendChild(item);
  }
  if (invitationPopupVisible) {
    list.querySelector(".btn-primary")?.focus(); // la lista cambió: el foco anterior ya no existe
  } else {
    openSheet("invitation-popup", list.querySelector(".btn-primary"));
  }
  invitationPopupVisible = true;
}

function hideInvitationPopup() {
  closeSheet("invitation-popup");
  invitationPopupVisible = false;
  renderedInvitationKey = null;
}

el("btn-dismiss-invitations").addEventListener("click", hideInvitationPopup);

async function acceptInvitation(inv) {
  if (!tables.has(inv.matchId) && tables.size >= MAX_TABLES) {
    hideInvitationPopup();
    showToast(`Ya tienes ${MAX_TABLES} mesas abiertas: cierra una para aceptar otra partida.`, 4500);
    return;
  }
  try {
    await api("POST", `/v1/matches/${inv.matchId}/join`, {
      body: { joinToken: inv.joinToken },
      idempotent: true,
    });
    hideInvitationPopup();
    openMatch(inv.matchId);
  } catch (err) {
    hideInvitationPopup();
    showToast(errorMessage(err));
  }
}

// ---------- Tus partidas ----------
let renderedMyMatchesKey = null;

async function refreshMyMatches() {
  if (document.hidden) return;
  try {
    renderMyMatches(await api("GET", "/v1/matches"));
  } catch {
    // no bloquea el lobby si falla
  }
}

function renderMyMatches(matches) {
  // Redibujar solo si cambió algo visible: si no, cada refresco quitaría el foco de teclado.
  const key = JSON.stringify([...matches.map((m) => [m.matchId, m.status, m.opponentName, m.handNumber, m.yourTurn]), [...tables.keys()]]);
  if (key === renderedMyMatchesKey) return;
  renderedMyMatchesKey = key;

  el("my-matches").classList.toggle("hidden", matches.length === 0);
  const list = el("my-matches-list");
  list.innerHTML = "";
  for (const match of matches) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "match-row";

    const text = document.createElement("span");
    text.className = "row-text";
    const who = document.createElement("span");
    who.className = "headline";
    who.textContent = match.opponentName ? `vs. ${match.opponentName}` : "Partida";
    const detail = document.createElement("span");
    detail.className = "footnote";
    const open = tables.has(match.matchId);
    detail.textContent =
      (match.status === "WAITING_FOR_OPPONENT" ? "Esperando que se una" : `Mano ${match.handNumber}`) + (open ? " · en una mesa" : "");
    text.append(who, detail);
    row.appendChild(text);

    if (match.yourTurn) {
      const badge = document.createElement("span");
      badge.className = "turn-badge";
      badge.textContent = "Tu turno";
      row.appendChild(badge);
    }
    row.setAttribute(
      "aria-label",
      `${who.textContent}, ${detail.textContent}${match.yourTurn ? ", es tu turno" : ""}. ${open ? "Ir a la mesa" : "Abrir en una mesa"}`,
    );
    row.addEventListener("click", () => openMatch(match.matchId));
    list.appendChild(row);
  }
}

// ---------- Lobby ----------
el("btn-copy-id").addEventListener("click", (evt) => copyText(el("my-player-id").value, evt.currentTarget));

/** Copia y confirma en el propio botón ("Copiado") durante un instante: sin diálogos. */
function copyText(value, button) {
  navigator.clipboard?.writeText(value).catch(() => {});
  if (!button) return;
  const original = button.textContent;
  button.textContent = "Copiado";
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1400);
}

const ruleInputs = ["input-starting-stack", "input-small-blind", "input-big-blind", "input-turn-timeout"];
function updateRulesSummary() {
  const [stack, sb, bb, secs] = ruleInputs.map((id) => el(id).value || "–");
  const rising = el("input-incremental-blinds").checked;
  const increment = Math.floor((Number(stack) * BLIND_INCREASE_PERCENT) / 100) || 0;
  el("rules-summary").textContent = `${fmt(Number(stack))} fichas · ${sb}/${bb}${rising ? " suben" : ""} · ${secs} s`;
  el("incremental-blinds-hint").textContent =
    `Cada ${BLIND_LEVEL_HANDS} manos, las dos suben el ${BLIND_INCREASE_PERCENT} % de las fichas iniciales (+${fmt(increment)}).`;
}
ruleInputs.forEach((id) => el(id).addEventListener("input", updateRulesSummary));
el("input-incremental-blinds").addEventListener("change", updateRulesSummary);

el("form-create-match").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("create-error");
  if (tables.size >= MAX_TABLES) {
    showError("create-error", `Ya tienes ${MAX_TABLES} mesas abiertas: cierra una para empezar otra partida.`);
    return;
  }
  const body = {
    startingStack: Number(el("input-starting-stack").value),
    smallBlind: Number(el("input-small-blind").value),
    bigBlind: Number(el("input-big-blind").value),
    turnTimeoutSeconds: Number(el("input-turn-timeout").value),
    incrementalBlinds: el("input-incremental-blinds").checked,
    inviteeId: el("input-invitee-id").value.trim(),
  };
  try {
    const match = await api("POST", "/v1/matches", { body, idempotent: true });
    el("input-invitee-id").value = "";
    openMatch(match.id);
  } catch (err) {
    showError("create-error", errorMessage(err));
  }
});

// ---------- init ----------
updateRulesSummary();
if (session?.token) {
  scheduleTokenRefresh();
  afterLogin();
} else {
  showScreen("auth");
}
