import { buildServer } from "./server.js";
import { config } from "../config.js";
import { runMaintenance } from "../application/maintenance.js";

const MAINTENANCE_INTERVAL_MS = 15_000;

const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });

let running = false;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  runMaintenance()
    .catch((err: unknown) => app.log.error({ err }, "Fallo el barrido de mantenimiento"))
    .finally(() => {
      running = false;
    });
}, MAINTENANCE_INTERVAL_MS);
timer.unref();
