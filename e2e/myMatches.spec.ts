import { test, expect } from "@playwright/test";
import { startMatch } from "./helpers.js";

test("al salir al lobby la partida aparece en «Tus partidas» y se puede volver a la mesa", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const handLabel = await ana.locator("#match-hand").textContent();

  await ana.locator("#btn-back-lobby").click();
  await expect(ana.locator("#screen-lobby")).toBeVisible();

  const row = ana.locator("#my-matches-list .match-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`vs. ${(await beto.locator("#lobby-name").textContent())!.trim()}`);
  await expect(row.locator(".turn-badge")).toHaveText("Tu turno"); // Ana es el botón y actúa primero

  await row.click();
  await expect(ana.locator("#screen-table")).toBeVisible();
  await expect(ana.locator("#match-hand")).toHaveText(handLabel!);
  await expect(ana.locator("#you-cards .card-tile")).toHaveCount(5);
});

test("sin partidas abiertas la sección no se muestra", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  await ana.locator("#btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();
  await expect(ana.locator("#match-status-line")).toHaveText("Partida terminada");
  await ana.getByRole("button", { name: "Volver al lobby" }).click();
  await expect(ana.locator("#screen-lobby")).toBeVisible();
  await expect(ana.locator("#my-matches")).toBeHidden();
});
