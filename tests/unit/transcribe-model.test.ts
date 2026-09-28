import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QUÉ MODELO recibe el audio. Se prueba contra `transcribeAudio` de verdad,
 * mirando el `model` que sale en la petición al proveedor — no contra una
 * copia de la escalera, que es justo lo que dejó pasar el bug.
 *
 * Incidente 2026-09-25: el prospecto mandó una nota de voz y el proveedor
 * contestó `404 No endpoints found that support input audio`. El modelo del
 * agente (`z-ai/glm-5.3-flash`) no acepta audio, y ninguno de esa familia lo
 * hace.
 *
 * Recaída 2026-09-28: al hacer que la transcripción respetara la config por
 * organización, se resolvía `transcribeModel ?? model` ANTES de mirar el
 * entorno. Una instancia con fila en el panel y el campo de audio vacío
 * mandaba el modelo del AGENTE y tapaba `OPENROUTER_TRANSCRIBE_MODEL`, que
 * estaba bien puesta. El 404 siguió en producción.
 */

const AGENTE = "z-ai/glm-5.3-flash"; // no acepta audio
const AUDIO = "google/gemini-2.5-flash-lite";

/** El `model` que viajó en la petición al proveedor. */
async function modeloPedido(
  aiConfig?: { apiToken?: string; transcribeModel?: string; model?: string }
): Promise<string | undefined> {
  let enviado: string | undefined;
  // `getEnv()` cachea lo parseado: sin esto, las variables de una prueba se
  // filtran a la siguiente y el test pasa (o falla) por el motivo equivocado.
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      enviado = JSON.parse(init?.body ?? "{}").model;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"text":"hola"}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    })
  );
  const { transcribeAudio } = await import("@/lib/ai");
  await transcribeAudio({
    data: Buffer.from("audio"),
    mimeType: "audio/ogg",
    aiConfig,
  });
  return enviado;
}

describe("qué modelo transcribe las notas de voz", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // Las obligatorias de `getEnv()`, ajenas a esto.
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "token-de-prueba");
    vi.stubEnv("OPENROUTER_API_TOKEN", "sk-or-de-entorno");
    vi.stubEnv("OPENROUTER_MODEL", AGENTE);
  });

  it("LA RECAÍDA: con fila de organización y sin modelo de audio, manda la VARIABLE", async () => {
    // El caso exacto de producción: panel configurado, campo de audio vacío,
    // OPENROUTER_TRANSCRIBE_MODEL bien puesta.
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", AUDIO);
    expect(await modeloPedido({ apiToken: "sk-or-de-la-org", model: AGENTE })).toBe(
      AUDIO
    );
  });

  it("el del panel gana a la variable de entorno", async () => {
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", AUDIO);
    expect(
      await modeloPedido({
        apiToken: "sk-or-de-la-org",
        transcribeModel: "mistralai/voxtral-small-24b-2507",
        model: AGENTE,
      })
    ).toBe("mistralai/voxtral-small-24b-2507");
  });

  it("sin nada dedicado, cae al modelo del agente (comportamiento de siempre)", async () => {
    expect(await modeloPedido({ apiToken: "sk-or-de-la-org", model: AGENTE })).toBe(
      AGENTE
    );
  });

  it("sin fila de organización, la variable manda sobre el modelo del entorno", async () => {
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", AUDIO);
    expect(await modeloPedido()).toBe(AUDIO);
  });

  it("con token de organización, el guardia del entorno NO corta", async () => {
    // Mismo bug que ya tenía `chatJson`: `isAiConfigured()` miraba process.env
    // y cortaba antes de usar el token de la organización.
    vi.stubEnv("OPENROUTER_API_TOKEN", "");
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", AUDIO);
    expect(await modeloPedido({ apiToken: "sk-or-de-la-org" })).toBe(AUDIO);
  });
});
