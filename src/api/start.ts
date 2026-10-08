import { buildServer } from "./server.js";
import { config } from "../config.js";
import { runMaintenance } from "../application/maintenance.js";
import { prisma } from "../infrastructure/prisma/client.js";
import { createShutdown } from "./lifecycle.js";

const MAINTENANCE_INTERVAL_MS = 15_000;
// Railway espera unos 30 s entre SIGTERM y SIGKILL; 10 s alcanza para las peticiones en curso.
const SHUTDOWN_GRACE_MS = 10_000;

const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });

let maintenanceRun: Promise<void> | null = null;
const timer = setInterval(() => {
  if (maintenanceRun) return;
  maintenanceRun = runMaintenance((err, context) => app.log.error({ err }, `Mantenimiento: ${context}`)).finally(() => {
    maintenanceRun = null;
  });
}, MAINTENANCE_INTERVAL_MS);
timer.unref();

const shutdown = createShutdown({
  app,
  stopTimers: () => clearInterval(timer),
  pendingWork: () => maintenanceRun,
  disconnect: () => prisma.$disconnect(),
  exit: (code) => process.exit(code),
  graceMs: SHUTDOWN_GRACE_MS,
});
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
