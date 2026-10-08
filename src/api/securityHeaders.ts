import type { FastifyInstance } from "fastify";

/**
 * CSP estricta: el cliente (public/) no usa scripts, estilos ni recursos externos o en línea, así que todo
 * se limita a 'self'. Es la defensa en profundidad para el JWT guardado en sessionStorage: aunque se
 * colara un XSS, el navegador no ejecutaría scripts inyectados ni dejaría enviar datos a otro origen.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  // Los navegadores la ignoran sobre HTTP, así que no afecta al desarrollo local.
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

/** Cabeceras de seguridad en todas las respuestas (API y estáticos), sin depender de un plugin externo. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    for (const [name, value] of Object.entries(HEADERS)) {
      reply.header(name, value);
    }
    // Las respuestas de la API llevan tokens, cartas y saldos: ningún proxy ni el navegador debe cachearlas.
    if (request.url.startsWith("/v1/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
}
