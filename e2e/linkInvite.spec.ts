import { test, expect, type Page } from "@playwright/test";
import { PASSWORD, login, mesa, newPlayerPage, uniqueName } from "./helpers.js";

/** Ana crea una partida con enlace y devuelve el enlace que muestra su mesa en espera. */
async function createLink(ana: Page): Promise<string> {
  await ana.getByRole("button", { name: "Crear partida con enlace" }).click();
  const field = mesa(ana).locator(".invite-link");
  await expect(field).toHaveValue(/\/#unirse=[A-Za-z0-9_-]+\.[0-9a-f]+$/);
  return field.inputValue();
}

test("invitar con un enlace: se copia, se abre sin sesión, se entra y empieza la partida", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  await ana.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const anaName = uniqueName("ana");
  await login(ana, anaName);
  const link = await createLink(ana);

  // "Copiar enlace" lo deja en el portapapeles.
  await mesa(ana).getByRole("button", { name: "Copiar enlace" }).click();
  await expect(mesa(ana).getByRole("button", { name: "Copiado" })).toBeVisible();
  expect(await ana.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // Beto abre el enlace sin haber entrado: se le pide entrar, y el token desaparece de la barra.
  const beto = await newPlayerPage(browser);
  await beto.goto(link);
  await expect(beto.locator("#auth-invite-note")).toBeVisible();
  expect(beto.url()).not.toContain("unirse");
  await beto.fill("#input-display-name", uniqueName("beto"));
  await beto.fill("#input-password", PASSWORD);
  await beto.click("#form-login button[type=submit]");

  // Antes de unirse (reserva fichas) se ve quién invita y con qué reglas.
  await expect(beto.locator("#invitation-list .headline")).toHaveText(anaName);
  await expect(beto.locator("#invitation-list .invitation-rules")).toHaveText("300 fichas · ciegas 10/20");
  await beto.getByRole("button", { name: "Jugar" }).click();

  await expect(mesa(beto).locator(".you-cards .card-tile")).toHaveCount(5);
  await expect(mesa(ana).locator(".you-cards .card-tile")).toHaveCount(5); // la sala de espera de Ana arranca sola
  await expect(mesa(ana).locator(".invite-link")).toHaveCount(0);
});

test("un enlace ya usado o inválido no deja unirse, y lo explica", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  const carla = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  await login(carla, uniqueName("carla"));
  const link = await createLink(ana);

  // Con la sesión abierta, pegar el enlace en la misma pestaña también funciona (solo cambia el #).
  await beto.goto(link);
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(mesa(beto).locator(".you-cards .card-tile")).toHaveCount(5);

  await carla.goto(link);
  await expect(carla.locator("#hand-result-banner")).toHaveText("Esa invitación ya no está disponible: la partida empezó o se canceló.");
  await carla.goto(link.replace(/\.[0-9a-f]+$/, ".0123456789abcdef0123456789abcdef"));
  await expect(carla.locator("#hand-result-banner")).toHaveText("El enlace de invitación no es válido o la partida ya no existe.");
});
