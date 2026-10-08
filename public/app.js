// Cliente web mínimo: consume la API REST del mismo origen. Sin framework, sin build step.
// El estado de sesión vive en sessionStorage (por pestaña) para poder abrir dos pestañas
// distintas y jugar contra uno mismo durante el desarrollo.

const SESSION_KEY = "poker_session_v1";
const LAST_MATCH_KEY = "poker_last_match_v1";
const POLL_INTERVAL_MS = 1500;
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
let pollTimer = null;
let countdownTimer = null;
let selectedDiscardIndexes = new Set();
let invitationPollTimer = null;
let dismissedInvitationIds = new Set();
let invitationPopupVisible = false;
let showdownAutoCloseTimer = null;
let toastTimer = null;
// Datos de la invitación recién creada, para mostrarlos en la sala de espera de la mesa.
let pendingInvite = null;
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

async function api(method, path, { body, idempotent = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (idempotent) headers["Idempotency-Key"] = crypto.randomUUID();

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

function openSheet(id, focusId) {
  el(id).classList.remove("hidden");
  if (focusId) el(focusId).focus();
}

function closeSheet(id) {
  el(id).classList.add("hidden");
}

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
  showScreen("lobby");
  refreshWallet();
  startInvitationPolling();
}

// ---------- Invitaciones pendientes ----------
function startInvitationPolling() {
  stopInvitationPolling();
  pollInvitations();
  invitationPollTimer = setInterval(pollInvitations, INVITATION_POLL_INTERVAL_MS);
}

function stopInvitationPolling() {
  if (invitationPollTimer) clearInterval(invitationPollTimer);
  invitationPollTimer = null;
}

async function pollInvitations() {
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

function renderInvitationPopup(invitations) {
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
  const wasVisible = invitationPopupVisible;
  el("invitation-popup").classList.remove("hidden");
  invitationPopupVisible = true;
  if (!wasVisible) list.querySelector(".btn-primary")?.focus();
}

function hideInvitationPopup() {
  el("invitation-popup").classList.add("hidden");
  invitationPopupVisible = false;
}

el("btn-dismiss-invitations").addEventListener("click", hideInvitationPopup);

async function acceptInvitation(inv) {
  hideError("join-error");
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
    pendingInvite = { matchId: match.id, joinToken: match.joinToken };
    el("input-invitee-id").value = "";
    setCurrentMatch(match.id);
    enterTable(match.id);
  } catch (err) {
    showError("create-error", err.message);
  }
});

el("form-join-match").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("join-error");
  const matchId = el("input-join-match-id").value.trim();
  const joinToken = el("input-join-token").value.trim();
  try {
    await api("POST", `/v1/matches/${matchId}/join`, { body: { joinToken }, idempotent: true });
    setCurrentMatch(matchId);
    enterTable(matchId);
  } catch (err) {
    showError("join-error", err.message);
  }
});

el("form-resume-match").addEventListener("submit", (evt) => {
  evt.preventDefault();
  const matchId = el("input-resume-match-id").value.trim();
  if (!matchId) return;
  setCurrentMatch(matchId);
  enterTable(matchId);
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
  renderedActionKey = null;
  renderedCardKeys.clear();
  showScreen("table");
  selectedDiscardIndexes = new Set();
  startPolling();
}

function startPolling() {
  stopPolling();
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  countdownTimer = setInterval(renderCountdown, COUNTDOWN_TICK_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  pollTimer = null;
  countdownTimer = null;
}

async function pollOnce() {
  if (!currentMatchId) return;
  try {
    const previousHandNumber = lastView?.handNumber;
    const view = await api("GET", `/v1/matches/${currentMatchId}`);
    if (previousHandNumber && view.handNumber > previousHandNumber) {
      showLastHandResult(previousHandNumber);
    }
    lastView = view;
    renderTable(view);
    if (view.status === "MATCH_FINISHED" || view.status === "CANCELLED") {
      refreshWallet();
    }
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      stopPolling();
      setCurrentMatch(null);
      showScreen("lobby");
      showToast("Esa partida ya no está disponible.");
    }
  }
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
    const how = audit.winReason === "FORFEIT" ? "por abandono" : "por retiro";
    showToast(`${youWon ? "Ganaste" : "Perdiste"} ${audit.pot.toLocaleString("es")} fichas ${how}`);
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
  el("showdown-result").textContent =
    audit.winReason === "SPLIT" ? `Empate · ${pot} fichas a medias` : `${youWon ? "Ganaste" : "Perdiste"} ${pot} fichas`;

  openSheet("showdown-popup", "btn-close-showdown");
  clearTimeout(showdownAutoCloseTimer);
  showdownAutoCloseTimer = setTimeout(hideShowdownPopup, 7000);
}

function hideShowdownPopup() {
  el("showdown-popup").classList.add("hidden");
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
  el("pot-amount").textContent = view.pot.toLocaleString("es");

  el("you-stack").textContent = waiting ? "–" : view.you.stack.toLocaleString("es");
  setBetChip("you", view.you.contribution);

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
  el("turn-indicator").textContent = view.turn ? (isYourTurn ? "Tu turno" : "Turno del rival") : "";

  renderActionPanel(view, isYourTurn);
  renderCountdown();

  el("btn-resign").classList.toggle("hidden", view.status !== "IN_PROGRESS" && view.status !== "WAITING_FOR_OPPONENT");

  if (finished) {
    stopPolling();
    renderFinished(view);
  }
}

function setBetChip(who, amount) {
  el(`${who}-contribution`).textContent = amount ? amount.toLocaleString("es") : "0";
  el(`${who}-bet`).classList.toggle("empty", !amount);
}

function renderFinished(view) {
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

  wrap.append(title, detail, makeButton("Nueva partida", "btn-primary", goToLobby));
  panel.appendChild(wrap);
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
  const card = document.createElement("div");
  card.className = "waiting-card";
  const p = document.createElement("p");
  p.className = "footnote";
  p.textContent = "Tu rival verá la invitación al entrar. Si prefiere unirse a mano, compártele estos datos:";
  card.appendChild(p);

  const invite = pendingInvite?.matchId === currentMatchId ? pendingInvite : { matchId: currentMatchId };
  for (const [label, value] of [["ID", invite.matchId], ["Token", invite.joinToken]]) {
    if (!value) continue;
    const line = document.createElement("div");
    line.className = "copy-line";
    const input = document.createElement("input");
    input.readOnly = true;
    input.value = value;
    input.setAttribute("aria-label", label);
    const btn = makeButton("Copiar", "btn-tinted", (evt) => copyText(value, evt.currentTarget));
    line.append(input, btn);
    card.appendChild(line);
  }
  return card;
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
