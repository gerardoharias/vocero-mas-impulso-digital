/**
 * PRUEBA REAL CONTROLADA contra OpenRouter (spec 023 §3.10).
 *
 * NO forma parte de `pnpm test` (que sólo corre tests/unit). Consume saldo REAL:
 * exactamente 2 llamadas facturables (≤ ~1 600 tokens de entrada y, con el tope
 * `maxTokens`, ≤ 400 de salida cada una), con un prompt mínimo, NO el del
 * negocio. Tope de gasto: 3 200 tokens de entrada + 800 de salida EN TOTAL.
 *
 * Triple candado — sin los tres, NO se hace ninguna llamada y la prueba se omite:
 *   1. AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO   (se pone a mano, justo antes de correr)
 *   2. AI_LIVE_MODEL=<id exacto>           (explícito: jamás se hereda OPENROUTER_MODEL
 *                                           del .env de desarrollo, que apunta al mock)
 *   3. un token en OPENROUTER_API_TOKEN dentro del archivo `.env.live`
 *
 * Uso (ver specs/023-…/spec.md §3.10):
 *   1. Averigua el modelo EXACTO de la organización, sin tokens:
 *        GET /api/settings/ai  → effective.agent.model   (y .source)
 *   2. Crea `.env.live` (gitignored, NO lo compartas) con:
 *        OPENROUTER_API_TOKEN=<una key con saldo mínimo>
 *        AI_LIVE_MODEL=<el modelo exacto del paso 1>
 *        OPENROUTER_BASE_URL=https://openrouter.ai/api
 *        AI_RESPONSE_FORMAT=auto            # o el valor que use producción
 *   3. AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO pnpm test:ai-live
 *
 * La prueba nunca imprime ni registra la API key: sólo modelo, modo, número de
 * llamadas, tipo de acción y duración.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CONFIRMED = process.env.AI_LIVE_CONFIRM === "SI_CONSUMIR_SALDO";
const HAS_TOKEN = Boolean(process.env.OPENROUTER_API_TOKEN?.trim());
const MODEL = (process.env.AI_LIVE_MODEL || "").trim();
const BASE = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api";
const runnable = CONFIRMED && HAS_TOKEN && MODEL !== "" && /^https:\/\/([\w-]+\.)?openrouter\.ai(\/|$)/.test(BASE);

if (!runnable) {
  const why = [
    !CONFIRMED && "falta AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO",
    !HAS_TOKEN && "falta OPENROUTER_API_TOKEN (en .env.live)",
    MODEL === "" && "falta AI_LIVE_MODEL (id exacto del modelo a probar)",
    !/^https:\/\/([\w-]+\.)?openrouter\.ai(\/|$)/.test(BASE) && "OPENROUTER_BASE_URL no es OpenRouter (¿apunta a un mock?)",
  ].filter(Boolean);
  process.stdout.write(`[ai-live] OMITIDA — NO se hizo ninguna llamada: ${why.join("; ")}\n`);
}

const PROSPECTO = "¿Me ayudas con mi tarea de historia sobre la revolución francesa?";
const SALUDO = "Hola, ¿qué hace Vocero?";

describe.skipIf(!runnable)("OpenRouter real con el modelo exacto configurado", () => {
  const captured: string[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  /** Llamadas HTTP REALES que salieron (contadas por la guardia de fetch, no por `chatJson`). */
  const http = { calls: 0, hosts: new Set<string>() };
  const realFetch = globalThis.fetch;
  /** UN presupuesto de 2 para AMBOS turnos: ningún reintento puede exceder lo autorizado. */
  let sharedBudget: import("@/lib/ai/budget").CallBudget | null = null;

  beforeAll(() => {
    // getEnv() valida el entorno completo: se rellenan sólo los huecos no relacionados con la IA.
    const fill = (k: string, v: string) => {
      if (!process.env[k]) process.env[k] = v;
    };
    fill("APP_BASE_URL", "http://localhost:3000");
    fill("DATABASE_URL", "postgresql://live:live@localhost:5432/live");
    fill("BETTER_AUTH_SECRET", "live-test-secret-not-used-xx");
    fill("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    fill("META_WEBHOOK_VERIFY_TOKEN", "live-verify-token");
    process.env.OPENROUTER_MODEL = MODEL;
    // Guardia DURA, independiente del adaptador: sólo hacia openrouter.ai y NUNCA más de 2 llamadas.
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      const host = new URL(url).hostname;
      if (host !== "openrouter.ai") throw new Error(`[ai-live] destino no autorizado: ${host}`);
      if (http.calls >= 2) throw new Error("[ai-live] límite de 2 llamadas alcanzado: no se hace la tercera");
      http.calls++;
      http.hosts.add(host);
      return realFetch(input as RequestInfo, init as RequestInit);
    }) as typeof fetch;
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          captured.push(args.map(String).join(" "));
        })
      );
    }
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    spies.forEach((s) => s.mockRestore());
  });

  async function turn(userText: string) {
    const { chatJson } = await import("@/lib/ai");
    const { createCallBudget } = await import("@/lib/ai/budget");
    sharedBudget ??= createCallBudget(2);
    const { agentActionSchema } = await import("@/server/ai/actions");
    const { buildAgentSystemPrompt } = await import("@/server/ai/prompts");
    const system = buildAgentSystemPrompt({
      profile: {
        name: "Max",
        tone: "Amable y breve",
        instructions:
          "Solo hablas de Vocero, un CRM de WhatsApp con agente de IA. Si preguntan por otro tema, di amablemente que sólo te enfocas en el CRM y propón continuar con la demostración.",
        escalationRules: null,
        greeting: null,
      } as never,
      kb: [
        { kind: "qa", question: "¿Qué es Vocero?", answer: "Un CRM de WhatsApp open source con agente de IA." } as never,
      ],
      stages: [{ name: "Nuevo" }, { name: "Interesado" }],
      agenda: false,
    });
    const budget = sharedBudget;
    const t0 = Date.now();
    const result = await chatJson(
      agentActionSchema(false),
      [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      {
        traceId: "cv_live_check",
        schemaName: "accion_agente",
        budget,
        correct: { invalidJson: false },
        // tope duro de gasto en la salida: una respuesta corta cabe de sobra en 400
        maxTokens: 400,
      }
    );
    return { result, budget, ms: Date.now() - t0 };
  }

  const expectedMode = () => {
    const v = (process.env.AI_RESPONSE_FORMAT || "auto").trim().toLowerCase();
    return v === "json_object" ? "json_object" : v === "off" ? "none" : "json_schema";
  };

  it("1) respuesta estructurada normal: UNA llamada, en el modo configurado, sin bajar de nivel", async () => {
    const { result, budget, ms } = await turn(SALUDO);
    process.stdout.write(
      `[ai-live] modelo=${MODEL} llamadas=${result.meta.calls} modo=${result.meta.mode} fellBack=${result.meta.fellBack} ok=${result.ok} accion=${result.ok ? result.data.action : result.error} ms=${ms}\n`
    );
    expect(result.ok, result.ok ? "" : `falló: ${result.error} (${result.detail})`).toBe(true);
    expect(result.meta.calls, "una respuesta estructurada normal necesita UNA llamada").toBe(1);
    expect(budget.remaining, "queda 1 llamada para el 2º turno").toBe(1);
    expect(http.calls, "llamadas HTTP reales tras el 1er turno").toBe(1);
    expect(
      result.meta.mode,
      `el modelo ${MODEL} no aceptó el modo configurado: ajusta AI_RESPONSE_FORMAT (json_object/off) o cambia de modelo`
    ).toBe(expectedMode());
    expect(result.meta.fellBack).toBe(false);
  }, 90_000);

  it("2) pregunta fuera de alcance: vuelve como acción `reply` (no handoff, sin efectos), en UNA llamada", async () => {
    const { result, ms } = await turn(PROSPECTO);
    process.stdout.write(
      `[ai-live] modelo=${MODEL} llamadas=${result.meta.calls} modo=${result.meta.mode} fellBack=${result.meta.fellBack} ok=${result.ok} accion=${result.ok ? result.data.action : result.error} httpTotal=${http.calls} ms=${ms}\n`
    );
    expect(result.ok, result.ok ? "" : `falló: ${result.error} (${result.detail})`).toBe(true);
    if (!result.ok) return;
    expect(result.meta.calls).toBe(1);
    expect(http.calls, "llamadas HTTP reales en total").toBe(2);
    expect(result.data.action, "una pregunta fuera de alcance se responde, no se escala").toBe("reply");
    expect(result.data.action === "reply" && result.data.text.trim().length > 0).toBe(true);
  }, 90_000);

  it("3) ni el prospecto, ni la respuesta del modelo, ni la API key aparecen en los logs", () => {
    const logs = captured.join("\n");
    const token = process.env.OPENROUTER_API_TOKEN!.trim();
    // Booleanos a propósito: un fallo de `toContain` imprimiría el texto recibido (con la key, si se filtrara).
    expect(logs.includes(token), "la API key NO debe aparecer en los logs").toBe(false);
    expect(logs.includes("Bearer"), "ningún header de autorización en los logs").toBe(false);
    expect(logs.includes("revolución francesa"), "el mensaje del prospecto no debe estar en los logs").toBe(false);
    expect(logs.includes(SALUDO), "el saludo del prospecto no debe estar en los logs").toBe(false);
    // lo operativo sí está
    expect(logs.includes("traceId=cv_live_check")).toBe(true);
    expect(logs.includes(`model=${MODEL}`)).toBe(true);
    expect(logs.includes("route=openrouter.ai")).toBe(true);
    expect(/durationMs=\d+/.test(logs)).toBe(true);
    expect(logs.includes("outcome=ok")).toBe(true);
    // y el total de llamadas HTTP reales fue exactamente el autorizado
    expect(http.calls, "llamadas HTTP reales").toBe(2);
    expect([...http.hosts]).toEqual(["openrouter.ai"]);
  });
});
