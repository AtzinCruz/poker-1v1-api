import { test, expect } from "@playwright/test";
import { login, mesa, newPlayerPage, startMatch, uniqueName } from "./helpers.js";

test("al salir al lobby la partida aparece en «Tus partidas» y se puede volver a la mesa", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  const handLabel = await mesa(ana).locator(".match-hand").textContent();

  await ana.locator("#btn-back-lobby").click();
  await expect(ana.locator("#screen-lobby")).toBeVisible();

  const row = ana.locator("#my-matches-list .match-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`vs. ${(await beto.locator("#lobby-name").textContent())!.trim()}`);
  await expect(row.locator(".turn-badge")).toHaveText("Tu turno"); // Ana es el botón y actúa primero

  await row.click();
  await expect(ana.locator("#screen-table")).toBeVisible();
  await expect(ana.locator(".mesa")).toHaveCount(1); // ya estaba abierta: no se duplica
  await expect(mesa(ana).locator(".match-hand")).toHaveText(handLabel!);
  await expect(mesa(ana).locator(".you-cards .card-tile")).toHaveCount(5);
});

test("sin partidas abiertas la sección no se muestra", async ({ browser }) => {
  const { ana } = await startMatch(browser);
  await mesa(ana).locator(".btn-resign").click();
  await ana.locator("#btn-resign-confirm").click();
  await expect(mesa(ana).locator(".match-status-line")).toHaveText("Partida terminada");
  await ana.getByRole("button", { name: "Volver al lobby" }).click();
  await expect(ana.locator("#screen-lobby")).toBeVisible();
  await expect(ana.locator("#my-matches")).toBeHidden();
});

test("el lobby no pide IDs ni tokens: invitaciones y «Tus partidas» los reemplazan", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  await expect(ana.getByText("Unirme con un código")).toHaveCount(0);
  await expect(ana.getByText("Reanudar una partida")).toHaveCount(0);

  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");
  await expect(mesa(ana).locator(".action-panel")).toHaveText("Invitación enviada. La mesa empieza en cuanto tu rival la acepte.");
  await expect(mesa(ana).locator(".action-panel input")).toHaveCount(0); // ya no hay ID ni token para copiar
});
