import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "contraseña-larga-e2e";

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Cada jugador usa su propia IP (X-Forwarded-For; el servidor confía en un salto y el primer
 * salto aquí es el propio test): sin esto, todos los logins compartirían el límite de 10/min.
 */
let ipCounter = 1;
export async function newPlayerPage(browser: Browser, contextOptions: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
  const n = ipCounter++;
  const context = await browser.newContext({
    ...contextOptions,
    extraHTTPHeaders: { "x-forwarded-for": `10.200.${(n >> 8) & 255}.${n & 255}` },
  });
  return context.newPage();
}

export async function login(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.fill("#input-display-name", name);
  await page.fill("#input-password", PASSWORD);
  await page.click("#form-login button[type=submit]");
  await expect(page.locator("#screen-lobby")).toBeVisible();
}

/** Ana crea la partida invitando a Beto; Beto acepta desde la hoja de invitación. */
export async function startMatch(
  browser: Browser,
  rules: { turnTimeoutSeconds?: number } = {},
): Promise<{ ana: Page; beto: Page }> {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));

  if (rules.turnTimeoutSeconds) {
    await ana.locator(".group-hero .disclosure summary").click();
    await ana.fill("#input-turn-timeout", String(rules.turnTimeoutSeconds));
  }
  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(ana.locator("#you-cards .card-tile")).toHaveCount(5);
  await expect(beto.locator("#you-cards .card-tile")).toHaveCount(5);
  return { ana, beto };
}
