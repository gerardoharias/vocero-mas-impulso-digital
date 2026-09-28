import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Pruebas de INTEGRACIÓN: pipeline + ingesta + envío contra un Postgres REAL
 * (una base desechable por archivo, con las migraciones de `drizzle/`), con
 * SÓLO las fronteras externas simuladas: Meta (`graphRequest`), el proveedor
 * de IA (`chatJson`) y el cálculo de disponibilidad. Ninguna toca la red.
 *
 *   pnpm test:integration
 *
 * Necesita un servidor Postgres alcanzable con `DATABASE_URL` (el del `.env`
 * de desarrollo sirve: NO se toca esa base, se crea y borra `vocero_it_*`).
 * `pnpm test` (unitarias, sin BD) no las incluye a propósito.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Cada archivo levanta su propia base; en serie para no saturar el servidor.
    fileParallelism: false,
    setupFiles: ["tests/integration/setup.ts"],
    env: {
      APP_BASE_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "integration-test-secret-0123456789",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      META_WEBHOOK_VERIFY_TOKEN: "integration-verify-token",
      AGENDA: "on",
      AGENT_COALESCE_MS: "0",
      // Sólo para la prueba de contrato de POST /api/bot/messages.
      BOT_API_KEY: "bot-key-integration-0123456789",
      OPENROUTER_API_TOKEN: "sk-test-not-real",
      OPENROUTER_MODEL: "test-model",
      // Reintentos en milisegundos (spec 024 §5): mismo algoritmo, otra escala.
      OUTBOX_RETRY_BASE_MS: "40",
      OUTBOX_RETRY_CAP_MS: "400",
      OUTBOX_POLL_MS: "25",
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
