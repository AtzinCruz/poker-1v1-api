import { test, expect } from "@playwright/test";
import { mesa, startMatch } from "./helpers.js";

test("al retirarse, ambos ven quién ganó la mano, quién se retiró y la ganancia neta", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const anaName = (await ana.locator("#lobby-name").textContent())!.trim();
  const betoName = (await beto.locator("#lobby-name").textContent())!.trim();

  // Ana (ciega chica, 10) se retira: Beto gana el pozo de 30, del que 20 eran suyos → +10 neto.
  await mesa(ana).getByRole("button", { name: "Retirarse" }).click();
  await expect(mesa(ana).locator(".hand-result-text")).toHaveText(`Ganó ${betoName} · te retiraste · −10 fichas`);
  await expect(mesa(beto).locator(".hand-result-text")).toHaveText(`Ganaste la mano · ${anaName} se retiró · +10 fichas`);
});

test("la mano que termina la partida también muestra su resultado", async ({ browser }) => {
  // Ciegas 45/90 con 100 fichas: si Ana (botón) se retira le quedan 55 y no cubre la grande siguiente.
  const { ana, beto } = await startMatch(browser, { startingStack: 100, smallBlind: 45, bigBlind: 90 });
  const anaName = (await ana.locator("#lobby-name").textContent())!.trim();
  const betoName = (await beto.locator("#lobby-name").textContent())!.trim();

  await mesa(ana).getByRole("button", { name: "Retirarse" }).click();
  await expect(mesa(ana).locator(".hand-result-text")).toHaveText(`Ganó ${betoName} · te retiraste · −45 fichas`);
  await expect(mesa(beto).locator(".hand-result-text")).toHaveText(`Ganaste la mano · ${anaName} se retiró · +45 fichas`);
  await expect(mesa(ana).locator(".finished .title")).toHaveText("Perdiste la partida");
  await expect(mesa(beto).locator(".finished .title")).toHaveText("Ganaste la partida");
});

test("si el rival abandona mientras estás en el lobby, tu saldo se actualiza solo", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser); // 300 fichas por jugador
  await beto.locator("#btn-back-lobby").click();
  await expect(beto.locator("#wallet-available")).toHaveText("700"); // 300 de sus 1000 están en la partida

  await mesa(ana).locator(".btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();

  // Beto recupera su stack (280) y gana el pozo de la mano (30); Ana se va con lo que le quedaba.
  await expect(beto.locator("#wallet-available")).toHaveText((1010).toLocaleString("es"), { timeout: 8000 });
  await expect(ana.locator("#wallet-available")).toHaveText("990");
  await expect(beto.locator("#my-matches")).toBeHidden();
});
