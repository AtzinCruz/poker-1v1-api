// Cliente web mínimo: consume la API REST del mismo origen. Sin framework, sin build step.
// El estado de sesión vive en sessionStorage (por pestaña) para poder abrir dos pestañas
// distintas y jugar contra uno mismo durante el desarrollo.

const SESSION_KEY = "poker_session_v1";
const LAST_MATCH_KEY = "poker_last_match_v1";
const POLL_INTERVAL_MS = 1500;
const COUNTDOWN_TICK_MS = 250;
const INVITATION_POLL_INTERVAL_MS = 3000;

const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };

let session = loadSession(); // { token, player: { id, displayName, fictionalBalance } }
let currentMatchId = sessionStorage.getItem(LAST_MATCH_KEY) || null;
let lastView = null;
let pollTimer = null;
let countdownTimer = null;
let selectedDiscardIndexes = new Set();
let invitationPollTimer = null;
let dismissedInvitationIds = new Set();
let invitationPopupVisible = false;

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
    throw new ApiError(res.status, parsed);
  }
  return parsed;
}

// ---------- Render helpers ----------
function formatCard(code, faceDown = false) {
  const tile = document.createElement("div");
  tile.className = "card-tile" + (faceDown ? " face-down" : "");
  if (!faceDown) {
    const suit = code.slice(-1);
    const rankPart = code.slice(0, -1);
    const rankLabel = RANK_LABEL[Number(rankPart)] || rankPart;
    const isRed = suit === "H" || suit === "D";
    if (isRed) tile.classList.add("red");
    tile.innerHTML = `<div>${rankLabel}</div><div>${SUIT_SYMBOL[suit] || suit}</div>`;
  }
  return tile;
}

function setWalletDisplay(wallet) {
  el("wallet-available").textContent = wallet.available;
  el("wallet-blocked").textContent = wallet.blocked;
}

async function refreshWallet() {
  try {
    const wallet = await api("GET", "/v1/wallet");
    setWalletDisplay(wallet);
  } catch {
    // no bloquea la UI si falla
  }
}

// ---------- Auth ----------
el("form-login").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("auth-error");
  const displayName = el("input-display-name").value.trim();
  if (!displayName) return;
  try {
    const result = await api("POST", "/v1/auth/dev-session", { body: { displayName } });
    saveSession(result);
    afterLogin();
  } catch (err) {
    showError("auth-error", err.message);
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
  setCurrentMatch(null);
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
    const p = document.createElement("p");
    p.textContent =
      `${inv.creatorDisplayName} te invitó a jugar — ` +
      `${inv.rules.startingStack} fichas, ciegas ${inv.rules.smallBlind}/${inv.rules.bigBlind}.`;
    item.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "invitation-actions";
    actions.appendChild(
      makeButton("Unirme", "btn-primary", () => acceptInvitation(inv)),
    );
    actions.appendChild(
      makeButton("Ignorar", "btn-ghost", () => {
        dismissedInvitationIds.add(inv.matchId);
        pollInvitations();
      }),
    );
    item.appendChild(actions);
    list.appendChild(item);
  }
  el("invitation-popup").classList.remove("hidden");
  invitationPopupVisible = true;
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
    showError("join-error", err.message);
  }
}

// ---------- Lobby ----------
el("btn-copy-id").addEventListener("click", () => copyInput("my-player-id"));

function copyInput(id) {
  const input = el(id);
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {});
}

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
    el("waiting-room-panel").hidden = false;
    el("waiting-match-id").value = match.id;
    el("waiting-join-token").value = match.joinToken;
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

el("btn-resign").addEventListener("click", async () => {
  if (!confirm("¿Seguro que quieres abandonar la partida? El rival gana el saldo en juego.")) return;
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
  showScreen("table");
  selectedDiscardIndexes = new Set();
  el("hand-result-banner").classList.add("hidden");
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
      showLastHandResult();
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
      showError("join-error", "Esa partida ya no está disponible.");
    }
  }
}

async function showLastHandResult() {
  try {
    const hands = await api("GET", `/v1/matches/${currentMatchId}/hands`);
    const last = hands[hands.length - 1];
    if (!last) return;
    const banner = el("hand-result-banner");
    const youWon = last.winnerId === session.player.id;
    const reasonLabel = { FOLD: "por retiro", SHOWDOWN: "por showdown", SPLIT: "bote dividido" }[last.winReason] || "";
    banner.textContent = last.winReason === "SPLIT"
      ? `Mano #${last.number}: bote dividido (${last.pot} fichas)`
      : `Mano #${last.number}: ${youWon ? "ganaste" : "perdiste"} ${reasonLabel} (${last.pot} fichas)`;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 4000);
  } catch {
    // no crítico
  }
}

function renderTable(view) {
  const statusLabel = {
    WAITING_FOR_OPPONENT: "Esperando al rival",
    IN_PROGRESS: "En curso",
    MATCH_FINISHED: "Partida terminada",
    CANCELLED: "Partida cancelada",
  }[view.status] || view.status;

  el("match-status-line").textContent =
    `${statusLabel} · Mano #${view.handNumber || 0}` + (view.phase ? ` · ${view.phase}` : "");

  el("pot-amount").textContent = view.pot;

  el("you-id").textContent = short(view.you.playerId) + " (vos)";
  el("you-stack").textContent = view.you.stack;
  el("you-contribution").textContent = view.you.contribution;

  if (view.opponent) {
    el("opponent-id").textContent = short(view.opponent.playerId);
    el("opponent-stack").textContent = view.opponent.stack;
    el("opponent-contribution").textContent = view.opponent.contribution;
    if (view.opponent.cards) {
      renderCards("opponent-cards", view.opponent.cards, false, view);
    } else {
      renderFaceDown("opponent-cards", view.opponent.cardCount);
    }
  } else {
    el("opponent-id").textContent = "— todavía no se unió —";
    el("opponent-stack").textContent = "–";
    el("opponent-contribution").textContent = "–";
    el("opponent-cards").innerHTML = "";
  }

  renderCards("you-cards", view.you.cards, false, view);

  const isYourTurn = view.turn && view.turn.playerId === session.player.id;
  el("you-panel").classList.toggle("active-turn", Boolean(isYourTurn));
  el("opponent-panel").classList.toggle("active-turn", Boolean(view.turn && !isYourTurn));

  renderActionPanel(view, isYourTurn);
  renderCountdown();

  el("btn-resign").classList.toggle("hidden", view.status !== "IN_PROGRESS" && view.status !== "WAITING_FOR_OPPONENT");

  if (view.status === "MATCH_FINISHED" || view.status === "CANCELLED") {
    stopPolling();
    const reasonLabel = { RESIGN: "abandono", INSUFFICIENT_STACK: "saldo insuficiente del rival" }[view.finishReason] || view.finishReason || "";
    const won = view.winnerId === session.player.id;
    el("action-panel").innerHTML = "";
    const p = document.createElement("p");
    p.className = "banner";
    p.textContent = view.winnerId
      ? `Partida terminada (${reasonLabel}). ${won ? "¡Ganaste! 🎉" : "Perdiste esta partida."}`
      : "Partida cancelada.";
    el("action-panel").appendChild(p);

    const actionsRow = document.createElement("div");
    actionsRow.className = "finished-actions";
    actionsRow.appendChild(makeButton("Nueva partida", "btn-primary", goToLobby));
    el("action-panel").appendChild(actionsRow);
  }
}

function short(id) {
  return id ? `${id.slice(0, 8)}…` : "";
}

function renderCards(containerId, cards, faceDown, view) {
  const container = el(containerId);
  container.innerHTML = "";
  const isDrawSelectable =
    containerId === "you-cards" &&
    view.phase === "DRAW" &&
    view.turn?.playerId === session.player.id;

  cards.forEach((code, index) => {
    const tile = formatCard(code, faceDown);
    if (isDrawSelectable) {
      tile.classList.add("selectable");
      if (selectedDiscardIndexes.has(index)) tile.classList.add("selected");
      tile.title = "Click para marcar/desmarcar para descarte";
      tile.addEventListener("click", () => {
        if (selectedDiscardIndexes.has(index)) {
          selectedDiscardIndexes.delete(index);
        } else {
          selectedDiscardIndexes.add(index);
        }
        renderCards(containerId, cards, faceDown, view);
        renderActionPanel(view, true);
      });
    }
    container.appendChild(tile);
  });
}

function renderFaceDown(containerId, count) {
  const container = el(containerId);
  container.innerHTML = "";
  for (let i = 0; i < (count || 0); i++) {
    container.appendChild(formatCard("??", true));
  }
}

function renderCountdown() {
  const indicator = el("turn-indicator");
  if (!lastView?.turn) {
    indicator.textContent = "";
    return;
  }
  const isYou = lastView.turn.playerId === session.player.id;
  const msLeft = new Date(lastView.turn.expiresAt).getTime() - Date.now();
  const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));
  indicator.textContent = `Turno de ${isYou ? "vos" : "el rival"} · ${secondsLeft}s`;
}

function renderActionPanel(view, isYourTurn) {
  const panel = el("action-panel");
  panel.innerHTML = "";
  hideError("action-error");

  if (view.status !== "IN_PROGRESS") return;
  if (!isYourTurn || !view.legalActions?.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = view.turn ? "Esperando al rival…" : "Esperando…";
    panel.appendChild(p);
    return;
  }

  for (const action of view.legalActions) {
    if (action.type === "DRAW") {
      const btn = makeButton(
        selectedDiscardIndexes.size === 0
          ? "Plantarse (no descartar)"
          : `Descartar ${selectedDiscardIndexes.size} carta(s)`,
        "btn-primary",
        () => submitAction({ type: "DRAW", discardedIndexes: [...selectedDiscardIndexes] }),
      );
      panel.appendChild(btn);
      continue;
    }
    if (action.type === "CHECK") {
      panel.appendChild(makeButton("Pasar (Check)", "btn-secondary", () => submitAction({ type: "BET", amount: 0 })));
    }
    if (action.type === "CALL") {
      panel.appendChild(
        makeButton(`Igualar (${action.amount})`, "btn-secondary", () => submitAction({ type: "BET", amount: action.amount })),
      );
    }
    if (action.type === "RAISE") {
      panel.appendChild(makeRaiseControl(action.min, action.max));
    }
    if (action.type === "ALL_IN") {
      panel.appendChild(makeButton("All-in", "btn-danger", () => submitAction({ type: "ALL_IN" })));
    }
    if (action.type === "FOLD") {
      panel.appendChild(makeButton("Retirarse (Fold)", "btn-ghost", () => submitAction({ type: "FOLD" })));
    }
  }
}

function makeButton(label, cls, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function makeRaiseControl(min, max) {
  const wrap = document.createElement("div");
  wrap.className = "raise-control";
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(min);
  const btn = makeButton(`Subir a`, "btn-primary", () => {
    const amount = Number(input.value);
    submitAction({ type: "BET", amount });
  });
  wrap.appendChild(document.createTextNode(`Subir (${min}–${max}):`));
  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}

async function submitAction(payload) {
  hideError("action-error");
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
      showError("action-error", "El estado cambió, revisá la mesa e intentá de nuevo.");
    } else {
      showError("action-error", err.message);
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
if (session?.token) {
  afterLogin();
} else {
  showScreen("auth");
}
