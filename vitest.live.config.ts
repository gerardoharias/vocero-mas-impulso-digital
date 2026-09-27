import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Pruebas REALES contra un proveedor externo (consumen saldo). Separadas a
 * propósito de `vitest.config.ts`: `pnpm test` jamás las toca. Ver
 * tests/live/ai-real.live.test.ts para el procedimiento y los candados.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
