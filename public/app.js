// Cliente web mínimo: consume la API REST del mismo origen. Sin framework, sin build step.
// El estado de sesión vive en sessionStorage (por pestaña) para poder abrir dos pestañas
// distintas y jugar contra uno mismo durante el desarrollo.

const SESSION_KEY = "poker_session_v1";
const LAST_MATCH_KEY = "poker_last_match_v1";
// El servidor sostiene cada GET ?since= hasta 25 s; el cliente corta a los 35 s por si la red se cuelga.
const LONG_POLL_CLIENT_TIMEOUT_MS = 35_000;
const POLL_RETRY_MS = 2000;
const COUNTDOWN_TICK_MS = 250;
const INVITATION_POLL_INTERVAL_MS = 3000;
const URGENT_SECONDS = 10;

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
let currentMatchId = sessionStorage.getItem(LAST_MATCH_KEY) || null;
let lastView = null;
// Cada startPolling/stopPolling cambia la generación: un bucle de una generación vieja se detiene solo.
let pollGeneration = 0;
let lastShownHandResult = 0;
// Long-poll en vuelo: se aborta al ocultar la pestaña (libera la conexión en el servidor).
let inFlightPoll = null;
let countdownTimer = null;
let selectedDiscardIndexes = new Set();
let invitationPollTimer = null;
let dismissedInvitationIds = new Set();
let invitationPopupVisible = false;
let showdownAutoCloseTimer = null;
let toastTimer = null;
// Duración observada del turno actual (la vista no trae turnTimeoutSeconds): alimenta el anillo.
let turnClock = { key: null, totalMs: 1 };
let renderedActionKey = null;
const renderedCardKeys = new Map();

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
}

function setCurrentMatch(matchId) {
  currentMatchId = matchId;
  if (matchId) {
    sessionStorage.setItem(LAST_MATCH_KEY, matchId);
  } else {
    sessionStorage.removeItem(LAST_MATCH_KEY);
  }
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Error HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
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

/** El token ya no sirve (vencido o revocado): limpiar la sesión y volver al login. */
function expireSession() {
  stopPolling();
  stopInvitationPolling();
  saveSession(null);
  setCurrentMatch(null);
  el("session-info").classList.add("hidden");
  showScreen("auth");
  showError("auth-error", "Tu sesión venció. Vuelve a entrar.");
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

function setWalletDisplay(wallet) {
  el("wallet-available").textContent = wallet.available.toLocaleString("es");
  el("wallet-blocked").textContent = wallet.blocked.toLocaleString("es");
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
  else if (!el("showdown-popup").classList.contains("hidden")) hideShowdownPopup();
  else if (invitationPopupVisible) hideInvitationPopup();
});

for (const [overlayId, close] of [
  ["resign-popup", () => closeSheet("resign-popup")],
  ["showdown-popup", () => hideShowdownPopup()],
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
    showError("auth-error", err.message);
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
    showError("password-error", err.message);
  }
});

el("btn-logout").addEventListener("click", () => {
  stopPolling();
  stopInvitationPolling();
  saveSession(null);
  setCurrentMatch(null);
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
  if (currentMatchId) {
    enterTable(currentMatchId);
  } else {
    goToLobby();
  }
}

/** Vuelve al lobby y retoma el chequeo de invitaciones pendientes. Reusado por varios botones. */
function goToLobby() {
  stopPolling();
  hideShowdownPopup();
  setCurrentMatch(null);
  lastView = null;
  renderedMyMatchesKey = null; // al volver, pintar la lista aunque no haya cambiado
  showScreen("lobby");
  refreshWallet();
  startInvitationPolling();
}

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
    rules.textContent =
      `${inv.rules.startingStack.toLocaleString("es")} fichas · ciegas ${inv.rules.smallBlind}/${inv.rules.bigBlind}`;
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
  try {
    await api("POST", `/v1/matches/${inv.matchId}/join`, {
      body: { joinToken: inv.joinToken },
      idempotent: true,
    });
    hideInvitationPopup();
    stopInvitationPolling();
    setCurrentMatch(inv.matchId);
    enterTable(inv.matchId);
  } catch (err) {
    hideInvitationPopup();
    showToast(err.message);
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
  const key = JSON.stringify(matches.map((m) => [m.matchId, m.status, m.opponentName, m.handNumber, m.yourTurn]));
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
    detail.textContent = match.status === "WAITING_FOR_OPPONENT" ? "Esperando que se una" : `Mano ${match.handNumber}`;
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
      `${who.textContent}, ${detail.textContent}${match.yourTurn ? ", es tu turno" : ""}. Ir a la mesa`,
    );
    row.addEventListener("click", () => {
      setCurrentMatch(match.matchId);
      enterTable(match.matchId);
    });
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
  el("rules-summary").textContent = `${Number(stack).toLocaleString("es")} fichas · ${sb}/${bb} · ${secs} s`;
}
ruleInputs.forEach((id) => el(id).addEventListener("input", updateRulesSummary));

el("form-create-match").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("create-error");
  const body = {
    startingStack: Number(el("input-starting-stack").value),
    smallBlind: Number(el("input-small-blind").value),
    bigBlind: Number(el("input-big-blind").value),
    turnTimeoutSeconds: Number(el("input-turn-timeout").value),
    inviteeId: el("input-invitee-id").value.trim(),
  };
  try {
    const match = await api("POST", "/v1/matches", { body, idempotent: true });
    el("input-invitee-id").value = "";
    setCurrentMatch(match.id);
    enterTable(match.id);
  } catch (err) {
    showError("create-error", err.message);
  }
});

// ---------- Table ----------
el("btn-back-lobby").addEventListener("click", goToLobby);

el("btn-resign").addEventListener("click", () => openSheet("resign-popup", "btn-resign-cancel"));
el("btn-resign-cancel").addEventListener("click", () => closeSheet("resign-popup"));
el("btn-resign-confirm").addEventListener("click", async () => {
  closeSheet("resign-popup");
  try {
    await api("POST", `/v1/matches/${currentMatchId}/resign`, { idempotent: true });
    await pollOnce();
  } catch (err) {
    showError("action-error", err.message);
  }
});

function enterTable(matchId) {
  stopInvitationPolling();
  hideInvitationPopup();
  hideShowdownPopup();
  lastView = null;
  lastShownHandResult = 0;
  renderedActionKey = null;
  renderedFinishedKey = null;
  renderedCardKeys.clear();
  showScreen("table");
  selectedDiscardIndexes = new Set();
  startPolling();
}

function startPolling() {
  stopPolling();
  countdownTimer = setInterval(renderCountdown, COUNTDOWN_TICK_MS);
  void pollLoop(pollGeneration);
}

function stopPolling() {
  pollGeneration += 1;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    inFlightPoll?.abort(); // el bucle ve la pestaña oculta y espera a que vuelva
  } else if (invitationPollTimer) {
    lobbyTick(); // al volver al lobby, revisar enseguida
  }
});

/**
 * Una petición a la vez (antes: setInterval cada 1.5 s, que acumulaba peticiones si el servidor
 * tardaba). La primera lectura es inmediata; después, long-poll con la versión que ya tenemos: el
 * servidor responde cuando la partida cambia. Con la pestaña oculta no se consulta nada.
 */
async function pollLoop(generation) {
  let since;
  while (generation === pollGeneration && currentMatchId) {
    if (document.hidden) {
      await untilVisible();
      since = undefined; // al volver, lectura inmediata: pudo pasar de todo
      continue;
    }
    const ok = await pollOnce(since, generation);
    if (!ok) await sleep(POLL_RETRY_MS); // red caída o 503: reintentar sin martillar
    since = lastView?.stateVersion;
  }
}

/** Lee la partida (con `since`, como long-poll). Devuelve false si falló y conviene reintentar. */
async function pollOnce(since, generation = pollGeneration) {
  if (!currentMatchId) return true;
  try {
    const previousHandNumber = lastView?.handNumber;
    const query = since !== undefined ? `?since=${since}` : "";
    const controller = new AbortController();
    if (since !== undefined) inFlightPoll = controller;
    let view;
    try {
      view = await api("GET", `/v1/matches/${currentMatchId}${query}`, {
        timeoutMs: LONG_POLL_CLIENT_TIMEOUT_MS,
        signal: controller.signal,
      });
    } finally {
      if (inFlightPoll === controller) inFlightPoll = null;
    }
    if (generation !== pollGeneration) return true; // se cambió de pantalla mientras esperaba
    // El long-poll y la lectura tras una jugada pueden cruzarse: nunca pintar un estado más viejo.
    if (lastView && view.id === lastView.id && view.stateVersion < lastView.stateVersion) return true;
    if (previousHandNumber && view.handNumber > previousHandNumber && previousHandNumber > lastShownHandResult) {
      lastShownHandResult = previousHandNumber;
      showLastHandResult(previousHandNumber);
    }
    lastView = view;
    renderTable(view);
    if (view.status === "MATCH_FINISHED" || view.status === "CANCELLED") {
      refreshWallet();
    }
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      stopPolling();
      setCurrentMatch(null);
      showScreen("lobby");
      showToast("Esa partida ya no está disponible.");
      return true;
    }
    // Abortado a propósito al ocultar la pestaña: no es un error, no hay que esperar para reintentar.
    if (err.name === "AbortError" && document.hidden) return true;
    return false;
  }
}

/** Fichas que ganó (o perdió) este jugador en la mano: lo que recibió del pozo menos lo que puso. */
function handNet(audit) {
  const slot = audit.player1Id === session.player.id ? "player1" : "player2";
  return (audit.payout[slot] ?? 0) - audit.contributions[slot];
}

/** "+10", "−20" (signo menos tipográfico), "0". */
function signed(amount) {
  const abs = Math.abs(amount).toLocaleString("es");
  return amount > 0 ? `+${abs}` : amount < 0 ? `−${abs}` : "0";
}

async function showLastHandResult(handNumber) {
  try {
    const audit = await api("GET", `/v1/matches/${currentMatchId}/hands/${handNumber}`);
    const youWon = audit.winnerId === session.player.id;

    if (audit.winReason === "SHOWDOWN" || audit.winReason === "SPLIT") {
      showShowdownPopup(audit, handNumber, youWon);
      return;
    }

    // Retiro: no hay showdown ni se revelan cartas (sección 2.3 del spec), solo un aviso breve.
    // Se informa el NETO: el pozo incluye lo que el propio ganador puso, y la mano siguiente ya
    // descontó su ciega, así que el stack "no se mueve" aunque haya ganado.
    const net = handNet(audit);
    const rival = lastView?.opponent?.displayName || "Tu rival";
    if (audit.winReason === "FORFEIT") {
      showToast(youWon ? `${rival} abandonó · ${signed(net)} fichas` : `Abandonaste · ${signed(net)} fichas`);
    } else {
      showToast(youWon ? `${rival} se retiró · ${signed(net)} fichas` : `Te retiraste · ${signed(net)} fichas`, 4500);
    }
  } catch {
    // no crítico
  }
}

function showShowdownPopup(audit, handNumber, youWon) {
  const youAreP1 = audit.player1Id === session.player.id;
  const yourCards = youAreP1 ? audit.revealedCards?.player1 : audit.revealedCards?.player2;
  const opponentCards = youAreP1 ? audit.revealedCards?.player2 : audit.revealedCards?.player1;

  el("showdown-title").textContent = `Mano ${handNumber} · Showdown`;
  el("showdown-you-cards").innerHTML = "";
  el("showdown-opponent-cards").innerHTML = "";
  (yourCards || []).forEach((code) => el("showdown-you-cards").appendChild(formatCard(code)));
  (opponentCards || []).forEach((code) => el("showdown-opponent-cards").appendChild(formatCard(code)));

  const pot = audit.pot.toLocaleString("es");
  const net = signed(handNet(audit));
  el("showdown-result").textContent =
    audit.winReason === "SPLIT"
      ? `Empate · pozo de ${pot} a medias (${net})`
      : `${youWon ? "Ganaste" : "Perdiste"} ${net} fichas · pozo de ${pot}`;

  openSheet("showdown-popup", "btn-close-showdown");
  clearTimeout(showdownAutoCloseTimer);
  showdownAutoCloseTimer = setTimeout(hideShowdownPopup, 7000);
}

function hideShowdownPopup() {
  closeSheet("showdown-popup");
  clearTimeout(showdownAutoCloseTimer);
}

el("btn-close-showdown").addEventListener("click", hideShowdownPopup);

function renderTable(view) {
  const finished = view.status === "MATCH_FINISHED" || view.status === "CANCELLED";
  el("match-hand").textContent = view.handNumber ? `Mano ${view.handNumber}` : "Mesa";
  el("match-status-line").textContent =
    view.status === "WAITING_FOR_OPPONENT"
      ? "Esperando a tu rival"
      : finished
        ? "Partida terminada"
        : PHASE_LABEL[view.phase] || "";

  const waiting = view.status === "WAITING_FOR_OPPONENT";
  document.querySelector(".table").classList.toggle("is-waiting", waiting);
  // Terminada: las fichas ya se repartieron; el pozo y las apuestas de la última mano solo confunden.
  document.querySelector(".table").classList.toggle("is-finished", view.status === "MATCH_FINISHED");
  el("pot-amount").textContent = view.pot.toLocaleString("es");

  el("you-stack").textContent = waiting ? "–" : view.you.stack.toLocaleString("es");
  setBetChip("you", view.you.contribution);

  const opponentName = view.opponent?.displayName || "Rival";
  el("opponent-name").textContent = opponentName;
  el("opponent-panel").setAttribute("aria-label", opponentName);
  el("showdown-opponent-name").textContent = opponentName;

  if (view.opponent) {
    el("opponent-stack").textContent = view.opponent.stack.toLocaleString("es");
    setBetChip("opponent", view.opponent.contribution);
    if (view.opponent.cards) {
      renderCards("opponent-cards", view.opponent.cards, false, view);
    } else {
      renderFaceDown("opponent-cards", view.opponent.cardCount);
    }
  } else {
    el("opponent-stack").textContent = "–";
    setBetChip("opponent", 0);
    el("opponent-cards").innerHTML = "";
    renderedCardKeys.delete("opponent-cards");
  }

  renderCards("you-cards", view.you.cards, false, view);

  const isYourTurn = Boolean(view.turn && view.turn.playerId === session.player.id);
  el("you-panel").classList.toggle("active-turn", isYourTurn);
  el("opponent-panel").classList.toggle("active-turn", Boolean(view.turn && !isYourTurn));
  el("turn-indicator").textContent = view.turn ? (isYourTurn ? "Tu turno" : `Turno de ${opponentName}`) : "";

  renderActionPanel(view, isYourTurn);
  renderCountdown();

  el("btn-resign").classList.toggle("hidden", view.status !== "IN_PROGRESS" && view.status !== "WAITING_FOR_OPPONENT");

  if (finished) {
    // Una partida terminada sigue escuchando (long-poll): así aparece al instante la revancha que
    // pida el rival. Solo una cancelada ya no puede cambiar.
    if (view.status === "CANCELLED") stopPolling();
    renderFinished(view);
  }
}

function setBetChip(who, amount) {
  el(`${who}-contribution`).textContent = amount ? amount.toLocaleString("es") : "0";
  el(`${who}-bet`).classList.toggle("empty", !amount);
}

let renderedFinishedKey = null;

function renderFinished(view) {
  // Solo redibujar si cambió algo (resultado u oferta de revancha): el long-poll despierta cada 25 s.
  const key = JSON.stringify([view.id, view.status, view.winnerId, view.finishReason, view.rematch]);
  if (key === renderedFinishedKey) return;
  const previous = renderedFinishedKey ? JSON.parse(renderedFinishedKey)[4] : undefined;
  renderedFinishedKey = key;

  const panel = el("action-panel");
  panel.innerHTML = "";
  hideHint();
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
    wrap.appendChild(makeRematchSection(view, previous));
  } else {
    wrap.appendChild(makeButton("Nueva partida", "btn-primary", goToLobby));
  }
  panel.appendChild(wrap);
}

/** Oferta, espera o acceso a la revancha según su estado; siempre con salida al lobby. */
function makeRematchSection(view, previousRematch) {
  const section = document.createElement("div");
  section.className = "rematch";
  const rival = view.opponent?.displayName || "Tu rival";
  const rematch = view.rematch && view.rematch.status !== "CANCELLED" ? view.rematch : null;
  const r = view.rules;

  const status = document.createElement("p");
  status.className = "rematch-status";
  const rules = document.createElement("p");
  rules.className = "footnote";
  rules.textContent =
    `Mismas reglas: ${r.startingStack.toLocaleString("es")} fichas · ciegas ${r.smallBlind}/${r.bigBlind} · ${r.turnTimeoutSeconds} s`;
  const actions = document.createElement("div");
  actions.className = "rematch-actions";
  const lobby = makeButton("Volver al lobby", "btn-gray", goToLobby);

  if (!rematch) {
    status.textContent = view.rematch?.status === "CANCELLED" ? "La revancha se canceló." : "¿Otra partida?";
    actions.append(lobby, makeButton("Revancha", "btn-primary", () => requestRematch(view.id)));
  } else if (rematch.status === "WAITING_FOR_OPPONENT" && !rematch.requestedByYou) {
    status.textContent = `${rival} quiere la revancha.`;
    actions.append(lobby, makeButton("Aceptar revancha", "btn-primary", () => requestRematch(view.id)));
    if (previousRematch?.matchId !== rematch.matchId) announce(`${rival} quiere la revancha.`);
  } else if (rematch.status === "WAITING_FOR_OPPONENT") {
    status.textContent = `Esperando a que ${rival} acepte la revancha.`;
    actions.append(lobby, makeButton("Ir a la revancha", "btn-tinted", () => openMatch(rematch.matchId)));
  } else {
    status.textContent = "La revancha ya empezó.";
    actions.append(lobby, makeButton("Ir a la revancha", "btn-primary", () => openMatch(rematch.matchId)));
  }
  section.append(status, rules, actions);
  return section;
}

function openMatch(matchId) {
  setCurrentMatch(matchId);
  enterTable(matchId);
}

/** Pide (o acepta, si el rival ya la pidió) la revancha y lleva a la mesa nueva. */
async function requestRematch(matchId) {
  hideError("action-error");
  const buttons = el("action-panel").querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const match = await api("POST", `/v1/matches/${matchId}/rematch`, { idempotent: true });
    refreshWallet();
    openMatch(match.id);
  } catch (err) {
    buttons.forEach((b) => (b.disabled = false));
    const entry = lastView?.rules?.startingStack?.toLocaleString("es") ?? "?";
    showError("action-error", err.code === "INSUFFICIENT_STACK" ? `No tienes saldo suficiente: la entrada es de ${entry} fichas.` : err.message);
  }
}

/** Vuelve a pintar las cartas solo si cambiaron, así la animación de reparto no se repite en cada poll. */
function renderCards(containerId, cards, faceDown, view) {
  const container = el(containerId);
  const isDrawSelectable =
    containerId === "you-cards" &&
    view.phase === "DRAW" &&
    view.turn?.playerId === session.player.id;

  const selection = isDrawSelectable ? [...selectedDiscardIndexes].sort().join(",") : "-";
  const key = `${view.handNumber}|${cards.join(",")}|${faceDown}|${selection}`;
  if (renderedCardKeys.get(containerId) === key) return;
  const isNewHand = !renderedCardKeys.get(containerId)?.startsWith(`${view.handNumber}|${cards.join(",")}|`);
  renderedCardKeys.set(containerId, key);
  // La animación de reparto solo corre cuando llegan cartas nuevas, no al marcar una para descartar.
  container.classList.toggle("settled", !isNewHand);
  container.innerHTML = "";

  cards.forEach((code, index) => {
    const tile = formatCard(code, faceDown);
    if (isDrawSelectable) {
      const selected = selectedDiscardIndexes.has(index);
      tile.classList.add("selectable");
      tile.classList.toggle("selected", selected);
      tile.setAttribute("role", "button");
      tile.setAttribute("tabindex", "0");
      tile.setAttribute("aria-pressed", String(selected));
      tile.setAttribute("aria-label", `${cardName(code)}${selected ? ", se descarta" : ""}`);
      const toggle = () => {
        if (selectedDiscardIndexes.has(index)) {
          selectedDiscardIndexes.delete(index);
        } else {
          selectedDiscardIndexes.add(index);
        }
        renderCards(containerId, cards, faceDown, view);
        renderActionPanel(view, true);
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

function renderFaceDown(containerId, count) {
  const container = el(containerId);
  const key = `down|${lastView?.handNumber}|${count}`;
  if (renderedCardKeys.get(containerId) === key) return;
  renderedCardKeys.set(containerId, key);
  container.classList.remove("settled");
  container.innerHTML = "";
  for (let i = 0; i < (count || 0); i++) {
    container.appendChild(formatCard("??", true));
  }
}

/** Anillo de cuenta regresiva. La duración total se toma del primer valor visto para ese turno. */
function renderCountdown() {
  const timer = el("turn-timer");
  if (!lastView?.turn) {
    timer.classList.add("idle");
    return;
  }
  const msLeft = Math.max(0, new Date(lastView.turn.expiresAt).getTime() - Date.now());
  const key = `${lastView.turn.playerId}|${lastView.turn.expiresAt}`;
  if (turnClock.key !== key) turnClock = { key, totalMs: Math.max(msLeft, 1) };

  const seconds = Math.ceil(msLeft / 1000);
  timer.classList.remove("idle");
  timer.classList.toggle("urgent", seconds <= URGENT_SECONDS);
  timer.style.setProperty("--progress", String(Math.min(1, msLeft / turnClock.totalMs)));
  el("turn-seconds").textContent = String(seconds);

  // El anillo es aria-hidden: un solo aviso por turno para lectores de pantalla antes del fold automático.
  if (lastView.turn.playerId === session.player.id && seconds <= URGENT_SECONDS && seconds > 0 && turnClock.warned !== key) {
    turnClock.warned = key;
    announce(`Quedan ${seconds} segundos para actuar.`);
  }
}

/** Región viva oculta: anuncia sin tocar el texto visible (que el polling reescribe). */
function announce(message) {
  const region = el("sr-announcer");
  region.textContent = "";
  setTimeout(() => (region.textContent = message), 50);
}

function showHint(text) {
  const hint = el("action-hint");
  hint.textContent = text;
  hint.classList.remove("hidden");
}

function hideHint() {
  el("action-hint").classList.add("hidden");
}

function renderActionPanel(view, isYourTurn) {
  const key = `${view.status}|${view.stateVersion}|${isYourTurn}|${[...selectedDiscardIndexes].sort().join(",")}`;
  if (renderedActionKey === key) return;
  renderedActionKey = key;
  const panel = el("action-panel");
  panel.innerHTML = "";
  hideHint();
  hideError("action-error");

  if (view.status === "WAITING_FOR_OPPONENT") {
    panel.appendChild(makeWaitingCard());
    return;
  }
  if (view.status !== "IN_PROGRESS") return;
  if (!isYourTurn || !view.legalActions?.length) {
    const p = document.createElement("p");
    p.className = "waiting";
    p.textContent = view.turn ? "Esperando al rival…" : "Esperando…";
    panel.appendChild(p);
    return;
  }

  const byType = Object.fromEntries(view.legalActions.map((a) => [a.type, a]));

  if (byType.DRAW) {
    const n = selectedDiscardIndexes.size;
    showHint(n === 0 ? "Toca las cartas que quieras cambiar." : `${n} ${n === 1 ? "carta marcada" : "cartas marcadas"} para cambiar.`);
    panel.appendChild(
      makeButton(n === 0 ? "Quedarme con estas" : `Cambiar ${n}`, "btn-primary", () =>
        submitAction({ type: "DRAW", discardedIndexes: [...selectedDiscardIndexes] }),
      ),
    );
    return;
  }

  // Orden fijo, de menor a mayor compromiso: retirarse · pasar/igualar · all-in · subir.
  if (byType.FOLD) panel.appendChild(makeButton("Retirarse", "btn-gray", () => submitAction({ type: "FOLD" })));
  if (byType.CHECK) panel.appendChild(makeButton("Pasar", "btn-tinted", () => submitAction({ type: "BET", amount: 0 })));
  if (byType.CALL) {
    panel.appendChild(
      makeButton(`Igualar ${byType.CALL.amount.toLocaleString("es")}`, "btn-tinted", () =>
        submitAction({ type: "BET", amount: byType.CALL.amount }),
      ),
    );
  }
  if (byType.ALL_IN) panel.appendChild(makeButton("All-in", "btn-gray", () => submitAction({ type: "ALL_IN" })));
  if (byType.RAISE) panel.appendChild(makeRaiseControl(byType.RAISE.min, byType.RAISE.max));
}

function makeWaitingCard() {
  const p = document.createElement("p");
  p.className = "waiting";
  p.textContent = "Invitación enviada. La mesa empieza en cuanto tu rival la acepte.";
  return p;
}

function makeButton(label, cls, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

/** Slider + valor en vivo + botón: un solo gesto para elegir y confirmar la subida. */
function makeRaiseControl(min, max) {
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

  const btn = makeButton("", "btn-primary", () => submitAction({ type: "BET", amount: Number(range.value) }));

  const sync = () => {
    const amount = Number(range.value);
    value.textContent = amount.toLocaleString("es");
    btn.textContent = amount === max ? "Subir todo" : "Subir";
    const pct = max === min ? 100 : ((amount - min) / (max - min)) * 100;
    range.style.setProperty("--fill-pct", `${pct}%`);
  };
  range.addEventListener("input", sync);
  sync();

  wrap.append(range, value, btn);
  return wrap;
}

async function submitAction(payload) {
  hideError("action-error");
  const buttons = el("action-panel").querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api("POST", `/v1/matches/${currentMatchId}/actions`, {
      body: { ...payload, actionVersion: lastView.stateVersion },
      idempotent: true,
    });
    selectedDiscardIndexes = new Set();
    await pollOnce();
  } catch (err) {
    if (err.code === "STALE_STATE") {
      await pollOnce();
      showError("action-error", "La mesa cambió. Revisa y vuelve a intentarlo.");
    } else {
      buttons.forEach((b) => (b.disabled = false));
      showError("action-error", err.message);
      renderedActionKey = null;
    }
  }
}

// ---------- misc ----------
function showError(id, message) {
  const node = el(id);
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideError(id) {
  el(id).classList.add("hidden");
}

// ---------- init ----------
updateRulesSummary();
if (session?.token) {
  afterLogin();
} else {
  showScreen("auth");
}
