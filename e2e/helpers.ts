import { expect, type Browser, type Locator, type Page, type Request } from "@playwright/test";

export const PASSWORD = "contraseña-larga-e2e";

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Cada jugador usa su propia IP (X-Forwarded-For): el servidor de E2E corre con TRUST_PROXY_HOPS=1
 * (playwright.config.ts), así que el test hace de proxy. Sin esto, todos los logins compartirían el
 * límite de 10/min y el de altas de cuentas por IP.
 */
let ipCounter = 1;
export async function newPlayerPage(browser: Browser, contextOptions: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
  const n = ipCounter++;
  const context = await browser.newContext({
    ...contextOptions,
    extraHTTPHeaders: { "x-forwarded-for": `10.200.${(n >> 8) & 255}.${n & 255}` },
  });
  const page = await context.newPage();
  trackLongPolls(page);
  return page;
}

/** Long-polls (GET /v1/matches/:id?since=N) en curso por página, para esperar a uno sin esperas fijas. */
const pendingLongPolls = new WeakMap<Page, Set<Request>>();
const isLongPoll = (req: Request) => req.method() === "GET" && /\/v1\/matches\/[^/]+\?since=\d+$/.test(req.url());

function trackLongPolls(page: Page): void {
  const pending = new Set<Request>();
  pendingLongPolls.set(page, pending);
  page.on("request", (req) => isLongPoll(req) && pending.add(req));
  page.on("requestfinished", (req) => pending.delete(req));
  page.on("requestfailed", (req) => pending.delete(req));
}

/** Espera a que la página tenga al menos un long-poll abierto (el servidor la despertará al cambiar algo). */
export async function waitForLongPoll(page: Page): Promise<void> {
  await expect.poll(() => pendingLongPolls.get(page)?.size ?? 0).toBeGreaterThan(0);
}

export async function login(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.fill("#input-display-name", name);
  await page.fill("#input-password", PASSWORD);
  await page.click("#form-login button[type=submit]");
  await expect(page.locator("#screen-lobby")).toBeVisible();
}

/** Ana crea la partida invitando a Beto; Beto acepta desde la hoja de invitación. */
export interface RulesOverride {
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
  turnTimeoutSeconds?: number;
  incrementalBlinds?: boolean;
}

/** La mesa `index` (en orden de apertura) de la pantalla de mesas. */
export function mesa(page: Page, index = 0): Locator {
  return page.locator(".mesa").nth(index);
}

/** Ana invita a Beto con las reglas dadas desde el lobby (sin esperar a que acepte). */
export async function invite(ana: Page, beto: Page, rules: RulesOverride = {}): Promise<void> {
  const fields: [keyof RulesOverride, string][] = [
    ["startingStack", "#input-starting-stack"],
    ["smallBlind", "#input-small-blind"],
    ["bigBlind", "#input-big-blind"],
    ["turnTimeoutSeconds", "#input-turn-timeout"],
  ];
  if (Object.values(rules).some((v) => v !== undefined)) {
    const disclosure = ana.locator(".group-hero .disclosure");
    if (!(await disclosure.evaluate((d) => (d as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
    for (const [key, selector] of fields) {
      if (rules[key] !== undefined) await ana.fill(selector, String(rules[key]));
    }
    if (rules.incrementalBlinds) await ana.check("#input-incremental-blinds");
  }
  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");
}

export async function startMatch(browser: Browser, rules: RulesOverride = {}): Promise<{ ana: Page; beto: Page }> {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  await invite(ana, beto, rules);
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(mesa(ana).locator(".you-cards .card-tile")).toHaveCount(5);
  await expect(mesa(beto).locator(".you-cards .card-tile")).toHaveCount(5);
  return { ana, beto };
}
