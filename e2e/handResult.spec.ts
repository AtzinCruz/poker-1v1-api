import { test, expect } from "@playwright/test";
import { startMatch } from "./helpers.js";

test("al retirarse, ambos ven la ganancia neta y quién se retiró (no el pozo bruto)", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const anaName = (await ana.locator("#lobby-name").textContent())!.trim();

  // Ana (ciega chica, 10) se retira: Beto gana el pozo de 30, del que 20 eran suyos → +10 neto.
  await ana.getByRole("button", { name: "Retirarse" }).click();
  await expect(ana.locator("#hand-result-banner")).toHaveText("Te retiraste · −10 fichas");
  await expect(beto.locator("#hand-result-banner")).toHaveText(`${anaName} se retiró · +10 fichas`);
});

test("si el rival abandona mientras estás en el lobby, tu saldo se actualiza solo", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  await beto.locator("#btn-back-lobby").click();
  await expect(beto.locator("#wallet-available")).toHaveText("0"); // sus 1000 están en la partida

  await ana.locator("#btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();

  // Beto recibe todo lo que había en juego: sus 1000 + los 1000 de Ana.
  await expect(beto.locator("#wallet-available")).toHaveText((2000).toLocaleString("es"), { timeout: 8000 });
  await expect(beto.locator("#my-matches")).toBeHidden();
});
