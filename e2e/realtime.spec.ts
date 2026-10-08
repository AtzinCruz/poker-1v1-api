import { test, expect, type Page } from "@playwright/test";
import { startMatch } from "./helpers.js";

/** Cuenta las peticiones de vista de partida que la página inicia (no las de acciones). */
function countMatchReads(page: Page): { readonly count: number } {
  const counter = { count: 0 };
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/v1\/matches\/[^/]+(\?|$)/.test(new URL(req.url()).pathname + new URL(req.url()).search)) {
      counter.count += 1;
    }
  });
  return counter;
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("la jugada del rival aparece al instante (long-poll, no un intervalo de 1.5 s)", async ({ browser }) => {
  const { ana, beto } = await startMatch(browser);
  // Ana es el botón y actúa primero; Beto espera su turno con un long-poll abierto.
  await expect(beto.locator("#turn-indicator")).toHaveText("Turno del rival");
  await beto.waitForTimeout(500);

  const started = Date.now();
  await ana.getByRole("button", { name: /^Igualar/ }).click();
  await expect(beto.locator("#turn-indicator")).toHaveText("Tu turno", { timeout: 5000 });
  expect(Date.now() - started).toBeLessThan(1200);
});

test("una mesa sin cambios no consulta cada 1.5 s", async ({ browser }) => {
  const { beto } = await startMatch(browser);
  await beto.waitForTimeout(500);
  const reads = countMatchReads(beto);
  await beto.waitForTimeout(6000);
  // Antes: ~4 lecturas en 6 s. Ahora: el long-poll abierto sigue esperando (≤ 1 nueva).
  expect(reads.count).toBeLessThanOrEqual(1);
});

test("al ocultar la pestaña corta el long-poll y no consulta; al volver lee enseguida", async ({ browser }) => {
  const { beto } = await startMatch(browser);
  await beto.waitForTimeout(500); // long-poll abierto

  const aborted = beto.waitForEvent("requestfailed", {
    predicate: (req) => /\/v1\/matches\/[^/]+$/.test(new URL(req.url()).pathname),
    timeout: 2000,
  });
  await setHidden(beto, true);
  await aborted; // la conexión en el servidor se libera, no queda colgada 25 s

  const reads = countMatchReads(beto);
  await beto.waitForTimeout(3000);
  expect(reads.count).toBe(0);

  // Sin `since`: una lectura inmediata, no otro long-poll.
  const readOnReturn = beto.waitForRequest(
    (req) => req.method() === "GET" && /\/v1\/matches\/[^/]+$/.test(new URL(req.url()).pathname) && !new URL(req.url()).search,
    { timeout: 3000 },
  );
  await setHidden(beto, false);
  await readOnReturn;
});
