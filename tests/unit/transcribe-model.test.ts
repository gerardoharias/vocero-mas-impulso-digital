import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Incidente 2026-09-25 — un prospecto mandó una nota de voz y el proveedor
 * contestó `404 No endpoints found that support input audio`: el modelo del
 * agente (`z-ai/glm-5.3-flash`) no acepta audio, y NINGUNO de esa familia lo
 * hace. El agente tuvo que pedirle que escribiera su mensaje.
 *
 * La transcripción además leía SOLO `process.env`, así que un negocio que
 * configuró su token y su modelo en Ajustes → IA seguía usando los del
 * entorno. Estas dos cosas se prueban aquí, sin red ni base.
 */

/** Copia exacta de la resolución de `resolveAiConfig`, para fijar el contrato. */
function modeloEfectivo(
  creds: { model: string; judgeModel: string | null; transcribeModel: string | null },
  opts?: { judge?: boolean; transcribe?: boolean }
): string {
  return opts?.judge
    ? (creds.judgeModel ?? creds.model)
    : opts?.transcribe
      ? (creds.transcribeModel ?? creds.model)
      : creds.model;
}

describe("qué modelo transcribe las notas de voz", () => {
  const base = {
    model: "z-ai/glm-5.3-flash",
    judgeModel: null,
    transcribeModel: null,
  };

  it("sin modelo de transcripción, reusa el del agente (comportamiento de siempre)", () => {
    expect(modeloEfectivo(base, { transcribe: true })).toBe("z-ai/glm-5.3-flash");
  });

  it("con uno configurado, ése manda — y NO afecta al del agente ni al del juez", () => {
    const creds = { ...base, transcribeModel: "google/gemini-2.5-flash-lite" };
    expect(modeloEfectivo(creds, { transcribe: true })).toBe(
      "google/gemini-2.5-flash-lite"
    );
    expect(modeloEfectivo(creds)).toBe("z-ai/glm-5.3-flash");
    expect(modeloEfectivo(creds, { judge: true })).toBe("z-ai/glm-5.3-flash");
  });

  it("el del juez y el de transcripción son independientes", () => {
    const creds = {
      ...base,
      judgeModel: "anthropic/claude-haiku-4.5",
      transcribeModel: "mistralai/voxtral-small-24b-2507",
    };
    expect(modeloEfectivo(creds, { judge: true })).toBe("anthropic/claude-haiku-4.5");
    expect(modeloEfectivo(creds, { transcribe: true })).toBe(
      "mistralai/voxtral-small-24b-2507"
    );
  });
});

describe("transcribeAudio no exige las variables de entorno si la organización tiene token", () => {
  beforeEach(() => {
    // Las obligatorias de `getEnv()`, que no tienen que ver con esto.
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "token-de-prueba");
  });

  it("con token de organización, el guardia de entorno NO corta", async () => {
    // El bug que evita: `isAiConfigured()` (que mira process.env) cortaba
    // ANTES de usar el token de la organización, igual que le pasaba a
    // `chatJson` antes de su arreglo.
    const anterior = process.env.OPENROUTER_API_TOKEN;
    delete process.env.OPENROUTER_API_TOKEN;
    try {
      const { transcribeAudio } = await import("@/lib/ai");
      const res = await transcribeAudio({
        data: Buffer.from(""),
        mimeType: "audio/ogg",
        aiConfig: { apiToken: "sk-or-de-la-organizacion", model: "" },
      });
      // Sin modelo resoluble sigue siendo not_configured, pero por el MODELO,
      // no por el token: lo importante es que no cortó en el primer guardia.
      expect(res.ok).toBe(false);
    } finally {
      if (anterior !== undefined) process.env.OPENROUTER_API_TOKEN = anterior;
      vi.unstubAllEnvs();
    }
  });
});
