// Panel de administración: página separada del juego, con su propia sesión (JWT de admin).
// Reusa el mismo origen/API, sin build step, igual que app.js.

const ADMIN_SESSION_KEY = "poker_admin_session_v1";

let adminSession = loadAdminSession(); // { token, name }

const el = (id) => document.getElementById(id);
const screens = {
  login: el("screen-admin-login"),
  panel: el("screen-admin-panel"),
};

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle("hidden", key !== name);
  }
}

function loadAdminSession() {
  try {
    const raw = sessionStorage.getItem(ADMIN_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAdminSession(next) {
  adminSession = next;
  if (next) {
    sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(next));
  } else {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Error HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
  }
}

async function api(method, path, { body, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (adminSession?.token) headers.Authorization = `Bearer ${adminSession.token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && adminSession?.token && path !== "/v1/auth/admin-session") {
      saveAdminSession(null);
      el("admin-session-info").classList.add("hidden");
      showScreen("login");
      showError("admin-login-error", "La sesión de administrador venció, entrá de nuevo.");
    }
    throw new ApiError(res.status, parsed);
  }
  return parsed;
}

function showError(id, message) {
  const node = el(id);
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideError(id) {
  el(id).classList.add("hidden");
}

// ---------- Login ----------
el("form-admin-login").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError("admin-login-error");
  const displayName = el("admin-input-name").value.trim();
  const secret = el("admin-input-secret").value;
  try {
    const session = await api("POST", "/v1/auth/admin-session", { body: { displayName, secret } });
    saveAdminSession(session);
    afterAdminLogin();
  } catch (err) {
    showError("admin-login-error", err.message);
  }
});

el("btn-admin-logout").addEventListener("click", () => {
  saveAdminSession(null);
  el("admin-session-info").classList.add("hidden");
  showScreen("login");
});

function afterAdminLogin() {
  el("admin-name").textContent = adminSession.name;
  el("admin-session-info").classList.remove("hidden");
  showScreen("panel");
  loadPlayers();
  loadMatches();
}

// ---------- Jugadores ----------
el("btn-refresh-players").addEventListener("click", loadPlayers);

async function loadPlayers() {
  hideError("admin-players-error");
  try {
    const players = await api("GET", "/v1/admin/players");
    renderPlayers(players);
  } catch (err) {
    showError("admin-players-error", err.message);
  }
}

function renderPlayers(players) {
  const tbody = el("players-tbody");
  tbody.innerHTML = "";
  for (const p of players) {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.className = "mono";
    idTd.textContent = p.id;
    tr.appendChild(idTd);

    const nameTd = document.createElement("td");
    nameTd.textContent = p.displayName;
    tr.appendChild(nameTd);

    const passwordTd = document.createElement("td");
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "btn btn-ghost";
    resetBtn.textContent = p.hasPassword ? "Restablecer" : "Asignar contraseña";
    resetBtn.title = "Genera una contraseña temporal (se muestra una sola vez) y cierra las sesiones abiertas de la cuenta";
    resetBtn.addEventListener("click", () => resetPassword(p));
    if (!p.hasPassword) {
      const note = document.createElement("div");
      note.className = "mono small";
      note.textContent = "sin contraseña: nadie puede entrar";
      passwordTd.appendChild(note);
    }
    passwordTd.appendChild(resetBtn);
    tr.appendChild(passwordTd);

    const availTd = document.createElement("td");
    availTd.textContent = p.fictionalBalance;
    tr.appendChild(availTd);

    const blockedTd = document.createElement("td");
    blockedTd.textContent = p.blockedBalance;
    tr.appendChild(blockedTd);

    const createdTd = document.createElement("td");
    createdTd.textContent = new Date(p.createdAt).toLocaleString();
    tr.appendChild(createdTd);

    const actionTd = document.createElement("td");
    const row = document.createElement("div");
    row.className = "add-balance-row";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.placeholder = "monto";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary";
    btn.textContent = "+ saldo";
    btn.addEventListener("click", () => addBalance(p.id, input));
    row.appendChild(input);
    row.appendChild(btn);
    actionTd.appendChild(row);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

async function resetPassword(player) {
  if (!confirm(`¿Generar una contraseña temporal para "${player.displayName}"? Se cerrarán sus sesiones abiertas y la contraseña actual dejará de servir.`)) return;
  hideError("admin-players-error");
  try {
    const result = await api("POST", `/v1/admin/players/${player.id}/reset-password`);
    const box = document.getElementById("temp-password-box");
    document.getElementById("temp-password-text").textContent =
      `Contraseña temporal de "${result.displayName}": ${result.temporaryPassword}`;
    box.classList.remove("hidden");
    await loadPlayers();
  } catch (err) {
    showError("admin-players-error", err.message);
  }
}

/**
 * Una clave por intención (jugador + monto): un doble clic o el reintento tras un corte de red la
 * reusan y el servidor acredita una sola vez. Se descarta cuando el servidor respondió.
 */
const pendingCreditKeys = new Map();

async function addBalance(playerId, input) {
  hideError("admin-players-error");
  const amount = Number(input.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    showError("admin-players-error", "Ingresá un monto entero positivo.");
    return;
  }
  const intent = `${playerId}:${amount}`;
  if (!pendingCreditKeys.has(intent)) pendingCreditKeys.set(intent, crypto.randomUUID());
  try {
    await api("POST", `/v1/admin/players/${playerId}/add-balance`, {
      body: { amount },
      idempotencyKey: pendingCreditKeys.get(intent),
    });
    pendingCreditKeys.delete(intent);
    input.value = "";
    await loadPlayers();
  } catch (err) {
    if (err instanceof ApiError) pendingCreditKeys.delete(intent); // respondió: la próxima es otra intención
    showError("admin-players-error", err.message);
  }
}

// ---------- Partidas ----------
el("btn-refresh-matches").addEventListener("click", loadMatches);

async function loadMatches() {
  hideError("admin-matches-error");
  try {
    const matches = await api("GET", "/v1/admin/matches");
    renderMatches(matches);
  } catch (err) {
    showError("admin-matches-error", err.message);
  }
}

function renderMatches(matches) {
  const tbody = el("matches-tbody");
  tbody.innerHTML = "";
  for (const m of matches) {
    const tr = document.createElement("tr");
    const cells = [
      m.id,
      m.status,
      m.player1DisplayName,
      m.player2DisplayName ?? "—",
      `${m.startingStack} (${m.smallBlind}/${m.bigBlind})`,
      m.handNumber,
      m.finishReason ?? "—",
      m.winnerDisplayName ?? "—",
      new Date(m.createdAt).toLocaleString(),
    ];
    cells.forEach((value, i) => {
      const td = document.createElement("td");
      if (i === 0) td.className = "mono";
      td.textContent = value;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

// ---------- init ----------
if (adminSession?.token) {
  afterAdminLogin();
} else {
  showScreen("login");
}

document.getElementById("btn-hide-temp-password").addEventListener("click", () => {
  document.getElementById("temp-password-text").textContent = "";
  document.getElementById("temp-password-box").classList.add("hidden");
});
