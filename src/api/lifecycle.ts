import type { FastifyInstance } from "fastify";

export interface ShutdownDeps {
  app: FastifyInstance;
  /** Detiene los timers que arrancan trabajo nuevo (barrido de mantenimiento). */
  stopTimers: () => void;
  /** Trabajo de fondo en curso que no debe cortarse a mitad de transacción. */
  pendingWork: () => Promise<unknown> | null;
  disconnect: () => Promise<void>;
  exit: (code: number) => void;
  graceMs: number;
}

/**
 * Apagado ordenado ante SIGTERM (cada despliegue en Railway lo envía): deja de aceptar
 * conexiones, espera las peticiones y el barrido en curso, cierra el pool y sale. Si algo se
 * cuelga, sale con código 1 al cumplirse `graceMs` para no bloquear el despliegue.
 * Devuelve una función idempotente: varias señales seguidas no repiten el apagado.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let inProgress: Promise<void> | null = null;

  return (signal: string) => {
    inProgress ??= (async () => {
      deps.app.log.info({ signal }, "Apagando: no se aceptan conexiones nuevas");
      deps.stopTimers();
      const force = setTimeout(() => {
        deps.app.log.error({ graceMs: deps.graceMs }, "El apagado excedió el tiempo de gracia; saliendo a la fuerza");
        deps.exit(1);
      }, deps.graceMs);
      force.unref();
      try {
        await deps.app.close();
        await deps.pendingWork();
        await deps.disconnect();
        clearTimeout(force);
        deps.exit(0);
      } catch (err) {
        clearTimeout(force);
        deps.app.log.error({ err }, "Error durante el apagado");
        deps.exit(1);
      }
    })();
    return inProgress;
  };
}
