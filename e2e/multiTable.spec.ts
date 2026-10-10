import { test, expect } from "@playwright/test";
import { invite, login, mesa, newPlayerPage, uniqueName } from "./helpers.js";

test("dos partidas a la vez, en pantalla dividida: cada mesa lleva su propio juego", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));

  // Primera partida.
  await invite(ana, beto);
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(mesa(beto).locator(".you-cards .card-tile")).toHaveCount(5);

  // Segunda: cada uno pide "Otra mesa" y la primera sigue abierta.
  await ana.locator("#btn-add-table").click();
  await invite(ana, beto);
  await beto.locator("#btn-add-table").click();
  await beto.getByRole("button", { name: "Jugar" }).click();

  for (const page of [ana, beto]) {
    await expect(page.locator(".mesa")).toHaveCount(2);
    await expect(mesa(page, 1).locator(".you-cards .card-tile")).toHaveCount(5);
    await expect(page.locator("#tables-summary")).toContainText("2 mesas");
  }

  // En escritorio quedan una al lado de la otra; en móvil, una debajo de la otra.
  const [first, second] = [await mesa(ana, 0).boundingBox(), await mesa(ana, 1).boundingBox()];
  const wide = (ana.viewportSize()?.width ?? 0) >= 960;
  if (wide) expect(Math.abs(first!.y - second!.y)).toBeLessThan(4);
  else expect(second!.y).toBeGreaterThan(first!.y + first!.height - 4);

  // Ana juega solo en la primera mesa: a Beto le toca ahí, y la segunda sigue esperando a Ana.
  await mesa(ana, 0).getByRole("button", { name: /^Igualar/ }).click();
  await expect(mesa(beto, 0).locator(".turn-indicator")).toHaveText("Tu turno");
  await expect(mesa(beto, 1).locator(".turn-indicator")).toHaveText(/^Turno de ana-/);
  await expect(mesa(beto, 0)).toHaveClass(/your-turn/);
  await expect(mesa(beto, 1)).not.toHaveClass(/your-turn/);

  // Cerrar una mesa no abandona la partida: sigue en «Tus partidas».
  await mesa(ana, 1).locator(".btn-close-table").click();
  await expect(ana.locator(".mesa")).toHaveCount(1);
  await ana.locator("#btn-back-lobby").click();
  await expect(ana.locator("#my-matches-list .match-row")).toHaveCount(2);
  await expect(ana.locator("#btn-open-tables")).toHaveText("Volver a tu mesa");
});

test("ciegas que suben: la mesa muestra las ciegas vigentes y cuándo suben", async ({ browser }) => {
  const ana = await newPlayerPage(browser);
  const beto = await newPlayerPage(browser);
  await login(ana, uniqueName("ana"));
  await login(beto, uniqueName("beto"));
  await expect(ana.locator("#input-starting-stack")).toHaveValue("300"); // stack inicial predeterminado

  await invite(ana, beto, { incrementalBlinds: true });
  await expect(ana.locator("#rules-summary")).toHaveText("300 fichas · 10/20 suben · 60 s");
  await beto.getByRole("button", { name: "Jugar" }).click();
  await expect(mesa(ana).locator(".blinds-line")).toHaveText("Ciegas 10/20 · suben en la mano 4");

  // Tres manos retirándose (quien tenga el turno): en la 4.ª las dos suben 15 (5 % de 300).
  for (let hand = 1; hand <= 3; hand++) {
    await expect(mesa(ana).locator(".match-hand")).toHaveText(`Mano ${hand}`);
    const anaTurn = (await mesa(ana).locator(".turn-indicator").textContent()) === "Tu turno";
    await mesa(anaTurn ? ana : beto).getByRole("button", { name: "Retirarse" }).click();
  }
  await expect(mesa(ana).locator(".match-hand")).toHaveText("Mano 4");
  await expect(mesa(ana).locator(".blinds-line")).toHaveText("Ciegas 25/35 · suben en la mano 7");
  await expect(mesa(ana).locator(".pot-amount")).toHaveText("60");
});
