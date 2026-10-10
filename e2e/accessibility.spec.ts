import { test, expect } from "@playwright/test";
import { login, mesa, newPlayerPage, startMatch, uniqueName } from "./helpers.js";

test("el anillo de foco es un contorno sólido del color de acento (WCAG 1.4.11)", async ({ browser }) => {
  const page = await newPlayerPage(browser);
  await page.goto("/");
  await page.keyboard.press("Tab"); // primer elemento enfocable: el campo de nombre
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab"); // botón Continuar
  const button = page.locator("#form-login button[type=submit]");
  await expect(button).toBeFocused();
  const outline = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
  });
  expect(outline.style).toBe("solid");
  expect(outline.width).toBe("2px");
  expect(outline.color).not.toMatch(/rgba\(.*, 0\.1\d?\)/); // ya no es el tinte al 12–18 %
});

test("la hoja de abandono atrapa el foco, bloquea la mesa y lo devuelve al cerrar", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  const resign = mesa(ana).locator(".btn-resign");
  await resign.focus();
  await ana.keyboard.press("Enter");

  await expect(ana.locator("#resign-popup")).toBeVisible();
  await expect(ana.locator("#btn-resign-cancel")).toBeFocused();
  expect(await ana.evaluate(() => (document.getElementById("app") as HTMLElement).inert)).toBe(true);

  // Tab y Mayús+Tab no salen de la hoja.
  await ana.keyboard.press("Tab");
  await expect(ana.locator("#btn-resign-confirm")).toBeFocused();
  await ana.keyboard.press("Tab");
  await expect(ana.locator("#btn-resign-cancel")).toBeFocused();
  await ana.keyboard.press("Shift+Tab");
  await expect(ana.locator("#btn-resign-confirm")).toBeFocused();

  await ana.keyboard.press("Escape");
  await expect(ana.locator("#resign-popup")).toBeHidden();
  await expect(resign).toBeFocused();
  expect(await ana.evaluate(() => (document.getElementById("app") as HTMLElement).inert)).toBe(false);
});

test("la hoja de invitación conserva el foco entre polls", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");

  const play = beto.getByRole("button", { name: "Jugar" });
  await expect(play).toBeFocused();
  // Al menos un poll de invitaciones más (cada 3 s), sin esperas fijas: se espera la respuesta.
  await beto.waitForResponse((res) => new URL(res.url()).pathname === "/v1/invitations");
  await expect(play).toBeFocused();
});

test("avisa a lectores de pantalla cuando quedan 10 segundos", async ({ browser }) => {
  test.setTimeout(45_000);
  const { ana } = await startMatch(browser, { turnTimeoutSeconds: 15 });
  // Ana es el botón y actúa primero: con 15 s de turno, el aviso llega a los ~5 s.
  await expect(ana.locator("#sr-announcer")).toHaveText(/Quedan (10|9) segundos para actuar\./, { timeout: 12_000 });
});
