import { test, expect } from "@playwright/test";
import { login, mesa, newPlayerPage, uniqueName } from "./helpers.js";

test("la mesa muestra el nombre del rival, como texto aunque contenga HTML", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  const anaName = uniqueName("ana");
  const hostileName = `<img src=x onerror=alert(1)>${Date.now().toString(36)}`;
  await login(ana, anaName);
  await login(beto, hostileName);

  let dialog = false;
  ana.on("dialog", () => (dialog = true));
  await ana.fill("#input-invitee-id", await beto.inputValue("#my-player-id"));
  await ana.click("#form-create-match button[type=submit]");
  await beto.getByRole("button", { name: "Jugar" }).click();

  await expect(mesa(ana).locator(".opponent-name")).toHaveText(hostileName);
  await expect(mesa(beto).locator(".opponent-name")).toHaveText(anaName);
  await expect(mesa(ana).locator(".opponent-panel img")).toHaveCount(0);
  await expect(mesa(ana).locator(".turn-indicator")).toHaveText("Tu turno");
  await expect(mesa(beto).locator(".turn-indicator")).toHaveText(`Turno de ${anaName}`);
  expect(dialog).toBe(false);
});
