import { expect, test, type Page } from "@playwright/test";
import { invite, login, mesa, newPlayerPage, startMatch, uniqueName } from "./helpers.js";

/*
 * Robustez del cliente (re-auditoría R2, AUDITORIA.md §7): doble clic, errores que no son JSON, la misma
 * mesa en varios navegadores, estado que no debe sobrevivir a la mano, revancha con la mesa cerrada y
 * validación del formulario. Es lógica del cliente, no de diseño: se corre solo en escritorio.
 */
test.skip(({ isMobile }) => isMobile, "lógica del cliente; no depende del tamaño de pantalla");

/** GET a la API con la sesión de la página: lo mismo que vería el propio cliente. */
async function apiAs<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const token = JSON.parse(sessionStorage.getItem("poker_session_v1") ?? "null")?.token;
    const res = await fetch(p, { headers: { authorization: `Bearer ${token}` } });
    return res.json();
  }, path) as Promise<T>;
}

const isLongPoll = (url: string) => /\/v1\/matches\/[^/?]+\?since=/.test(url);

test("R2-02 doble clic en «Invitar»: una sola partida y una sola reserva", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  const creates: string[] = [];
  ana.on("request", (r) => r.method() === "POST" && r.url().endsWith("/v1/matches") && creates.push(r.url()));

  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.dblclick("#form-create-match button[type=submit]");
  await expect(mesa(ana)).toBeVisible();
  await expect(ana.locator("#form-create-match button[type=submit]")).toBeEnabled(); // la petición terminó

  expect(creates).toHaveLength(1);
  expect((await apiAs<{ blocked: number }>(ana, "/v1/wallet")).blocked).toBe(300);
  expect(await apiAs<unknown[]>(ana, "/v1/matches")).toHaveLength(1);
});

test("R2-02 doble clic en «Crear partida con enlace»: una sola partida", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await ana.dblclick("#btn-create-link");
  await expect(mesa(ana)).toBeVisible();
  await expect(ana.locator("#btn-create-link")).toBeEnabled();
  expect(await apiAs<unknown[]>(ana, "/v1/matches")).toHaveLength(1);
});

test("R2-02 doble clic en «Jugar»: una sola unión y ningún error con el jugador ya sentado", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  const joins: string[] = [];
  beto.on("request", (r) => r.method() === "POST" && /\/join$/.test(r.url()) && joins.push(r.url()));

  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");
  await beto.getByRole("button", { name: "Jugar" }).dblclick();
  await expect(mesa(beto).locator(".you-cards .card-tile")).toHaveCount(5);
  await beto.waitForTimeout(1000); // que llegue la respuesta de una segunda unión, si la hubo

  expect(joins).toHaveLength(1);
  await expect(beto.locator("#hand-result-banner")).toBeHidden();
});

test("R2-03 un 502 en HTML de un proxy se explica, no se muestra como error de JSON", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  await ana.route("**/v1/matches/*/actions", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" }),
  );
  await mesa(ana).getByRole("button", { name: "Retirarse" }).click();
  await expect(mesa(ana).locator(".action-error")).toHaveText("El servidor no responde ahora mismo. Reintenta en unos segundos.");
});

test("R2-01 la misma mesa en 4 navegadores: sin bucle de long-polls y todos siguen al día", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  // Tres navegadores más con la misma sesión y las mismas mesas (contextos aparte = cachés HTTP aparte).
  const storage = await ana.evaluate(() => JSON.stringify(sessionStorage));
  const devices: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `10.203.0.${i + 1}` } });
    await context.addInitScript((s) => {
      for (const [k, v] of Object.entries(JSON.parse(s) as Record<string, string>)) sessionStorage.setItem(k, v);
    }, storage);
    devices.push(await context.newPage());
  }
  let longPolls = 0;
  for (const page of [ana, ...devices]) page.on("request", (r) => r.method() === "GET" && isLongPoll(r.url()) && longPolls++);
  await Promise.all(devices.map((d) => d.goto("/")));
  await ana.waitForTimeout(10_000);
  // Antes: ~235 en 10 s (el sobrante preguntaba sin pausa) y después 429 durante casi un minuto para todos.
  expect(longPolls).toBeLessThan(30);

  // Una jugada se ve en los 4 (el que quedó fuera del tope reintenta a los pocos segundos).
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click();
  for (const page of [ana, ...devices]) {
    await expect(mesa(page).locator(".turn-indicator")).toHaveText(/^Turno de /);
  }
});

test("R2-04 tras turnos vencidos, el draw siguiente empieza sin cartas marcadas", async ({ browser }) => {
  test.setTimeout(150_000);
  const { ana, beto } = await startMatch(browser, { turnTimeoutSeconds: 15 });

  // Mano 1: Ana (botón) iguala, Beto pasa → DRAW de Ana: marca dos cartas y deja vencer el turno.
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await expect(mesa(ana).locator(".you-cards .card-tile.selectable")).toHaveCount(5);
  await mesa(ana).locator(".you-cards .card-tile").nth(0).click();
  await mesa(ana).locator(".you-cards .card-tile").nth(2).click();
  await expect(mesa(ana).getByRole("button", { name: "Cambiar 2" })).toBeVisible();

  // Desde aquí todas las acciones de Ana son automáticas: ninguna acción suya vacía la selección.
  const wait = { timeout: 30_000 };
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click(wait); // tras su draw automático
  await mesa(beto).getByRole("button", { name: "Pasar" }).click(wait); // tras su check automático → showdown
  await mesa(beto).getByRole("button", { name: /^Igualar/ }).click(wait); // mano 2: Beto es el botón
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click(wait); // tras el check de Ana

  await expect(mesa(ana).locator(".you-cards .card-tile.selectable")).toHaveCount(5, wait);
  await expect(mesa(ana).locator(".you-cards .card-tile.selected")).toHaveCount(0);
  await expect(mesa(ana).getByRole("button", { name: "Quedarme con estas" })).toBeVisible();
});

test("R2-04 control: en el flujo normal tampoco pasa la selección a la mano siguiente", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await expect(mesa(ana).locator(".you-cards .card-tile.selectable")).toHaveCount(5);
  await mesa(ana).locator(".you-cards .card-tile").nth(0).click();
  await mesa(ana).getByRole("button", { name: "Cambiar 1" }).click();
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click();
  await mesa(ana).getByRole("button", { name: "Pasar" }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await mesa(beto).getByRole("button", { name: /^Igualar/ }).click();
  await mesa(ana).getByRole("button", { name: "Pasar" }).click();
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click();
  await expect(mesa(ana).locator(".you-cards .card-tile.selectable")).toHaveCount(5);
  await expect(mesa(ana).locator(".you-cards .card-tile.selected")).toHaveCount(0);
});

test("R2-05 perder por inactividad no se anuncia como «Abandonaste»", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const betoId = await beto.inputValue("#my-player-id");
  // La desconexión real tarda ~3 min (acciones automáticas seguidas): aquí la vista dice que ya ocurrió.
  const fakeFor = new Set<Page>();
  for (const page of [ana, beto]) {
    await page.route(/\/v1\/matches\/[^/?]+(\?since=\d+)?$/, async (route) => {
      const response = await route.fetch();
      if (!fakeFor.has(page) || route.request().method() !== "GET") return route.fulfill({ response });
      const view = await response.json();
      const won = view.you.playerId === betoId;
      Object.assign(view, {
        status: "MATCH_FINISHED",
        finishReason: "DISCONNECT_TIMEOUT",
        winnerId: betoId,
        turn: null,
        legalActions: [],
        lastHand: { number: view.handNumber, winnerId: betoId, winReason: "FORFEIT", pot: 30, net: won ? 10 : -10, folderId: null, timedOut: false },
      });
      return route.fulfill({ response, json: view });
    });
  }

  fakeFor.add(ana);
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click(); // la lectura tras la jugada trae la vista falsa
  await expect(mesa(ana).locator(".hand-result-text")).toHaveText(/^Perdiste por inactividad · /);

  fakeFor.add(beto);
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await expect(mesa(beto).locator(".hand-result-text")).toHaveText(/^Ganaste la mano · .+ se desconectó · /);

  // Los long-polls siguen pasando por la ruta: soltarla antes de cerrar, o su fetch falla con el test ya terminado.
  await Promise.all([ana, beto].map((page) => page.unrouteAll({ behavior: "ignoreErrors" })));
});

test("R2-06 cerrar la mesa mientras se crea la revancha: la revancha queda en «Tus partidas»", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  await mesa(ana).locator(".btn-resign").click();
  await ana.click("#btn-resign-confirm");
  await expect(mesa(ana).getByRole("button", { name: "Revancha" })).toBeVisible();

  await ana.route("**/v1/matches/*/rematch", async (route) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await route.continue();
  });
  await mesa(ana).getByRole("button", { name: "Revancha" }).click();
  await mesa(ana).locator(".btn-close-table").click(); // mientras la revancha sigue en vuelo

  await expect(ana.locator("#hand-result-banner")).toHaveText("La revancha está lista en «Tus partidas».");
  await expect(ana.locator("#my-matches-list .match-row")).toHaveCount(1);
});

test("R2-07 «Crear partida con enlace» valida el formulario antes de enviar", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  const creates: string[] = [];
  ana.on("request", (r) => r.method() === "POST" && r.url().endsWith("/v1/matches") && creates.push(r.url()));

  const disclosure = ana.locator(".group-hero .disclosure");
  await disclosure.locator("summary").click();
  await ana.fill("#input-starting-stack", "50"); // mínimo 100
  await disclosure.locator("summary").click(); // cerrada: el campo inválido queda oculto
  await ana.click("#btn-create-link");

  await expect(disclosure).toHaveJSProperty("open", true);
  expect(await ana.locator("#input-starting-stack").evaluate((e) => (e as HTMLInputElement).validationMessage)).not.toBe("");
  await ana.waitForTimeout(500);
  expect(creates).toHaveLength(0);
});

test("una mano completa sin errores de consola ni violaciones de CSP", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const problems: string[] = [];
  for (const page of [ana, beto]) {
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" || /Content Security Policy|Refused to/i.test(msg.text())) problems.push(`console: ${msg.text()}`);
    });
  }
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await expect(mesa(ana).locator(".you-cards .card-tile.selectable")).toHaveCount(5);
  await mesa(ana).locator(".you-cards .card-tile").nth(1).click();
  await mesa(ana).getByRole("button", { name: "Cambiar 1" }).click();
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click();
  await mesa(ana).getByRole("button", { name: "Pasar" }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await expect(mesa(ana).locator(".hand-result-text")).toHaveText(/Ganaste la mano|Ganó|Empate/);
  expect(problems).toEqual([]);
});

/** ¿Algún elemento de `selector` (dentro de la mesa) queda debajo del resultado flotante? */
async function coveredByResult(page: Page, selector: string): Promise<number> {
  return page.evaluate(async (sel) => {
    // Con las animaciones finitas ya terminadas (reparto de cartas, entrada del resultado): a mitad del
    // reparto las cartas todavía están volando desde el pozo.
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    const box = document.querySelector(".mesa .hand-result")!.getBoundingClientRect();
    return [...document.querySelectorAll(sel)].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    }).length;
  }, selector);
}

test("R3-01 el resultado de la mano no tapa tus cartas cuando te toca actuar; Escape lo cierra", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  // Mano 1 hasta el showdown; en la mano 2 Beto es el botón y actúa primero.
  await mesa(ana).getByRole("button", { name: /^Igualar/ }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();
  await mesa(ana).getByRole("button", { name: "Quedarme con estas" }).click();
  await mesa(beto).getByRole("button", { name: "Quedarme con estas" }).click();
  await mesa(ana).getByRole("button", { name: "Pasar" }).click();
  await mesa(beto).getByRole("button", { name: "Pasar" }).click();

  // A Beto le toca: solo la línea de texto, y sus cartas nuevas quedan a la vista.
  await expect(mesa(beto).locator(".hand-result")).toBeVisible();
  await expect(mesa(beto).getByRole("button", { name: /^Igualar/ })).toBeVisible();
  await expect(mesa(beto).locator(".hand-result-hands")).toBeHidden();
  expect(await coveredByResult(beto, ".mesa .you-cards .card-tile")).toBe(0);

  // Ana espera: el resultado completo, con las dos manos del showdown (el diseño se mantiene).
  await expect(mesa(ana).locator(".hand-result-hands")).toBeVisible();
  await ana.keyboard.press("Escape");
  await expect(mesa(ana).locator(".hand-result")).toBeHidden();
});

test("R3-02 el texto de ejemplo de los campos cumple 4,5:1 de contraste", async ({ browser }) => {
  const page = await newPlayerPage(browser);
  await login(page, uniqueName("ana"));
  const ratio = await page.locator("#input-invitee-id").evaluate((input) => {
    const parse = (c: string) => {
      const p = c.match(/rgba?\(([^)]+)\)/)![1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    };
    const over = (t: number[], b: number[]) => {
      const a = t[3]! + b[3]! * (1 - t[3]!);
      return [0, 1, 2].map((i) => (t[i]! * t[3]! + b[i]! * b[3]! * (1 - t[3]!)) / a).concat(a);
    };
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const layers: number[][] = [];
    for (let n: Element | null = input; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3]! > 0) layers.push(c);
      if (c[3]! >= 1) break;
    }
    let bg = [7, 11, 9, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i]!, bg);
    const fg = over(parse(getComputedStyle(input, "::placeholder").color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("R3-03 un nombre que empieza con un emoji se ve entero en el avatar", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("🂡ana"));
  await login(beto, uniqueName("beto"));
  await invite(ana, beto);
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(mesa(ana).locator(".you-avatar")).toHaveText("🂡");
  await expect(mesa(beto).locator(".opponent-avatar")).toHaveText("🂡");
});
