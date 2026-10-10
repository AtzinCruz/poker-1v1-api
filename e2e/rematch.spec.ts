import { test, expect } from "@playwright/test";
import { mesa, startMatch } from "./helpers.js";

test("revancha: uno la pide, el otro la ve al instante en su mesa y al aceptarla empieza con las mismas reglas", async ({ browser }) => {
  // Entrada de 150 de los 1000 iniciales: los dos conservan saldo para la revancha.
  const { ana, beto } = await startMatch(browser, { startingStack: 150, smallBlind: 5, bigBlind: 30, turnTimeoutSeconds: 45 });
  const betoName = (await beto.locator("#lobby-name").textContent())!.trim();

  await mesa(ana).locator(".btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();
  await expect(beto.locator(".rematch-status")).toHaveText("¿Otra partida?");
  await expect(beto.locator(".rematch .footnote")).toHaveText("Mismas reglas: 150 fichas · ciegas 5/30 · 45 s");

  await beto.getByRole("button", { name: "Revancha" }).click();
  await expect(mesa(beto).locator(".match-status-line")).toHaveText("Esperando a tu rival");

  // Ana sigue en su mesa terminada: la oferta llega por el long-poll, sin recargar ni ir al lobby.
  await expect(ana.locator(".rematch-status")).toHaveText(`${betoName} quiere la revancha.`, { timeout: 5000 });
  await ana.getByRole("button", { name: "Aceptar revancha" }).click();

  for (const page of [ana, beto]) {
    // La revancha ocupa el lugar de la mesa terminada: sigue habiendo una sola.
    await expect(page.locator(".mesa")).toHaveCount(1);
    await expect(mesa(page).locator(".match-hand")).toHaveText("Mano 1");
    await expect(mesa(page).locator(".you-cards .card-tile")).toHaveCount(5);
    await expect(mesa(page).locator(".pot-amount")).toHaveText("35"); // ciegas 5 + 30: mismas reglas
  }
  // Beto creó la revancha, así que es el botón y pone la ciega chica (150 - 5).
  await expect(mesa(beto).locator(".you-stack")).toHaveText("145");
  await expect(mesa(ana).locator(".you-stack")).toHaveText("120");
});

test("sin saldo para otra entrada, la revancha explica por qué no se puede", async ({ browser }) => {
  // Entrada de 1000 (todo su saldo): al abandonar, Ana se va con 990 y ya no alcanza para otra.
  const { ana } = await startMatch(browser, { startingStack: 1000 });
  await mesa(ana).locator(".btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();
  await mesa(ana).getByRole("button", { name: "Revancha" }).click();
  await expect(mesa(ana).locator(".action-error")).toHaveText(`No tienes saldo suficiente: la entrada es de ${(1000).toLocaleString("es")} fichas.`);
  await expect(ana.locator("#screen-table")).toBeVisible();
});
