import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  chatJson,
  extractJson,
  resetResponseFormatMemory,
  testAiCredentials,
  transcribeAudio,
} from "@/lib/ai";
import { Verdict } from "@/server/lab/judge";

describe("extractJson (extracción robusta)", () => {
  it("JSON limpio", () => {
    expect(extractJson('{"action":"none"}')).toEqual({ action: "none" });
  });

  it("bloque ```json con texto alrededor", () => {
    const raw = 'Claro, aquí está:\n```json\n{"action":"reply","text":"hola"}\n```\nEspero que sirva.';
    expect(extractJson(raw)).toEqual({ action: "reply", text: "hola" });
  });

  it("JSON incrustado en prosa corta (primer { al último })", () => {
    const raw = 'La acción que tomaré es {"action":"handoff","reason":"cliente"} por lo dicho.';
    expect(extractJson(raw)).toEqual({ action: "handoff", reason: "cliente" });
  });

  it("sin JSON → null", () => {
    expect(extractJson("no tengo nada que decir")).toBeNull();
  });

  it("sólo cuentan los OBJETOS: un número o un string JSON son texto", () => {
    expect(extractJson("42")).toBeNull();
    expect(extractJson('"ok"')).toBeNull();
    expect(extractJson("[1,2,3]")).toBeNull();
    expect(extractJson("null")).toBeNull();
  });

  it("una respuesta larga que CONTIENE un ejemplo JSON es conversación, no una orden", () => {
    const prose = "Te explico cómo funciona el traspaso a una persona en nuestro sistema. ".repeat(6);
    expect(extractJson(`${prose} Ejemplo: {"action":"handoff"}`)).toBeNull();
    expect(
      extractJson(`${prose}\n\`\`\`json\n{"action":"handoff"}\n\`\`\``)
    ).toBeNull();
  });
});

describe("chatJson", () => {
  const schema = z.object({ action: z.literal("reply"), text: z.string() });

  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    vi.stubEnv("AI_RESPONSE_FORMAT", "");
    resetResponseFormatMemory();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function providerResponse(content: string, extra: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], ...extra }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  const REPLY_OK = '{"action":"reply","text":"ok"}';
  const ask = () => chatJson(schema, [{ role: "user", content: "hola" }]);
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);

  // ─── petición estructurada ─────────────────────────────────────────

  describe("petición estructurada (response_format)", () => {
    it("por defecto pide json_schema estricto derivado de Zod, exigiendo el parámetro en OpenRouter", async () => {
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);

      const result = await chatJson(schema, [{ role: "user", content: "hola" }], {
        schemaName: "accion_agente",
      });
      expect(result.ok).toBe(true);
      const body = bodyOf(fetchMock, 0);
      expect(body.model).toBe("modelo-test");
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "accion_agente",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["reply"] },
              text: { type: "string" },
            },
            required: ["action", "text"],
            additionalProperties: false,
          },
        },
      });
      expect(body.provider).toEqual({ require_parameters: true });
    });

    it("un proveedor que no es OpenRouter no recibe el campo `provider`", async () => {
      vi.stubEnv("OPENROUTER_BASE_URL", "https://llm.interno.example/api");
      vi.resetModules(); // getEnv() está memoizado: se recarga con el host nuevo
      const { chatJson: chatJsonOtroHost } = await import("@/lib/ai");
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJsonOtroHost(schema, [{ role: "user", content: "hola" }]);
      expect(result.ok).toBe(true);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("llm.interno.example");
      expect(bodyOf(fetchMock, 0).response_format.type).toBe("json_schema");
      expect(bodyOf(fetchMock, 0).provider).toBeUndefined();
    });

    it("AI_RESPONSE_FORMAT=json_object → modo de compatibilidad", async () => {
      vi.stubEnv("AI_RESPONSE_FORMAT", "json_object");
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      await ask();
      expect(bodyOf(fetchMock, 0).response_format).toEqual({ type: "json_object" });
    });

    it("`maxTokens` es opt-in: sin él no viaja `max_tokens`; con él, exactamente ese tope", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(providerResponse(REPLY_OK)));
      vi.stubGlobal("fetch", fetchMock);
      await ask();
      expect(bodyOf(fetchMock, 0)).not.toHaveProperty("max_tokens");
      await chatJson(schema, [{ role: "user", content: "hola" }], { maxTokens: 400 });
      expect(bodyOf(fetchMock, 1).max_tokens).toBe(400);
    });

    it("AI_RESPONSE_FORMAT=off → sólo { model, messages }, como antes", async () => {
      vi.stubEnv("AI_RESPONSE_FORMAT", "off");
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      await ask();
      expect(Object.keys(bodyOf(fetchMock, 0)).sort()).toEqual(["messages", "model"]);
    });

    it("un esquema fuera del subconjunto de Zod cae a json_object (no rompe)", async () => {
      const exotic = z.object({ n: z.number().transform((x) => x + 1) });
      const fetchMock = vi.fn().mockResolvedValue(providerResponse('{"n":1}'));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(exotic, [{ role: "user", content: "hola" }]);
      expect(result.ok).toBe(true);
      expect(bodyOf(fetchMock, 0).response_format).toEqual({ type: "json_object" });
    });

    it("el JSON estricto trae null en lo que no aplica y se valida contra el Zod real", async () => {
      const union = z.discriminatedUnion("action", [
        z.object({ action: z.literal("none") }),
        z.object({ action: z.literal("reply"), text: z.string().min(1) }),
      ]);
      const strict = vi
        .fn()
        .mockResolvedValue(providerResponse('{"action":"none","text":null}'));
      vi.stubGlobal("fetch", strict);
      const result = await chatJson(union, [{ role: "user", content: "hola" }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual({ action: "none" });
    });
  });

  // ─── camino feliz ──────────────────────────────────────────────────

  describe("camino feliz", () => {
    it("JSON válido → exactamente UNA llamada", async () => {
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (result.ok) {
        expect(result.data.text).toBe("ok");
        expect(result.meta).toMatchObject({ calls: 1, corrected: false, mode: "json_schema" });
      }
    });

    it("JSON dentro de markdown sigue tolerado, en una llamada", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(providerResponse("Claro:\n```json\n" + REPLY_OK + "\n```"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── formato: texto plano, JSON inválido, esquema ──────────────────

  describe("fallos de formato (máx. una corrección)", () => {
    it("texto plano con corrección desactivada → 1 llamada, invalid_json, borrador en memoria, detail sin contenido", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(providerResponse("Solo me enfoco en temas de CRM."));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [{ role: "user", content: "hola" }], {
        correct: { invalidJson: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_json");
        expect(result.draft).toBe("Solo me enfoco en temas de CRM.");
        expect(result.detail).not.toContain("CRM");
      }
    });

    it("texto plano por defecto → UNA corrección COMPACTA (sin el historial) que recupera", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(providerResponse("prosa que no es json"))
        .mockResolvedValueOnce(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [
        { role: "system", content: "PROMPT-LARGO-DEL-AGENTE" },
        { role: "user", content: "mensaje del cliente" },
      ]);
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.stringify(bodyOf(fetchMock, 1).messages);
      expect(second).toContain("prosa que no es json"); // el borrador
      expect(second).not.toContain("PROMPT-LARGO-DEL-AGENTE");
      expect(second).not.toContain("mensaje del cliente");
    });

    it("JSON válido que no cumple el esquema → UNA corrección con contexto y sólo rutas, nunca valores", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(providerResponse('{"action":"reply","text":123}'))
        .mockResolvedValueOnce(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [
        { role: "system", content: "PROMPT" },
        { role: "user", content: "mensaje del cliente" },
      ]);
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const msgs = bodyOf(fetchMock, 1).messages as { role: string; content: string }[];
      expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(msgs.at(-1)!.content).toContain("text: invalid_type");
    });

    it("una salida que nunca cumple → 2 llamadas (no 3), invalid_schema, y detail sin la salida", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(providerResponse('{"action":"secreto-del-cliente"}'))
        );
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_schema");
        expect(result.detail).not.toContain("secreto-del-cliente");
        expect(result.meta.corrected).toBe(true);
      }
    });

    it("texto plano dos veces → 2 llamadas, invalid_json; jamás tres", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(providerResponse("sólo prosa")));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (!result.ok) expect(result.error).toBe("invalid_json");
    });

    it("la corrección es una sola en total, se elija cuál se elija", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(providerResponse('{"action":"otra"}')) // schema
        .mockResolvedValueOnce(providerResponse("ahora prosa")) // corrección: json
        .mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(false);
    });
  });

  // ─── transporte: reintentos por clase ──────────────────────────────

  describe("reintentos por clase de error", () => {
    it("500 persistente → 1 + 2 reintentos con backoff, provider_error tipado, jamás excepción", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("provider_error");
        expect(result.status).toBe(500);
        expect(result.detail).not.toContain("boom");
      }
    });

    it("un 500 transitorio se recupera al reintentar", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("x", { status: 502 }))
        .mockResolvedValueOnce(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("429 con Retry-After espera EXACTAMENTE ese tiempo antes de reintentar", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        )
        .mockResolvedValueOnce(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    });

    it("429 con un Retry-After enorme no bloquea el turno: rate_limited al instante con retryAfterMs", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response("x", { status: 429, headers: { "retry-after": "120" } })
        );
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("rate_limited");
        expect(result.retryAfterMs).toBe(120_000);
      }
    });

    it("429 persistente sin header → backoff y se rinde tras 2 reintentos", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("x", { status: 429 })));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(1000 + 2000);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      if (!result.ok) expect(result.error).toBe("rate_limited");
    });

    it("timeout → código `timeout` (no invalid_json), con UN solo reintento", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = chatJson(schema, [{ role: "user", content: "hola" }], {
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(2500);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("timeout");
    });

    it("fallo de red (fetch rechaza) → network_error tras los reintentos acotados", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      if (!result.ok) expect(result.error).toBe("network_error");
    });

    it("401 → unauthorized SIN reintentos (error determinista)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("Invalid API key", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) {
        expect(result.error).toBe("unauthorized");
        expect(result.detail).not.toContain("Invalid API key");
      }
    });

    it("402 (sin créditos) → provider_error sin reintentos", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("x", { status: 402 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("provider_error");
    });

    it("HTTP 200 con `error` en el cuerpo se clasifica por su código", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: 502, message: "upstream" } }), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("nunca supera el presupuesto de 3 llamadas por invocación", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("x", { status: 503 })));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  // ─── compatibilidad entre modelos ──────────────────────────────────

  /** Rechazo EXPLÍCITO del proveedor: el parámetro response_format no es soportado. */
  const unsupportedFormat = (status = 400) =>
    new Response(
      JSON.stringify({
        error: {
          message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
          type: "invalid_request_error",
          param: "response_format",
          code: "unsupported_parameter",
        },
      }),
      { status }
    );

  describe("modelo sin soporte de response_format (sólo ante una señal EXPLÍCITA)", () => {
    it("auto: rechazo explícito baja UN nivel, sigue en el que funciona y lo RECUERDA", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unsupportedFormat())
        // un Response nuevo por llamada: su cuerpo sólo puede leerse una vez
        .mockImplementation(() => Promise.resolve(providerResponse(REPLY_OK)));
      vi.stubGlobal("fetch", fetchMock);

      const first = await ask();
      expect(first.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(fetchMock, 0).response_format.type).toBe("json_schema");
      expect(bodyOf(fetchMock, 1).response_format).toEqual({ type: "json_object" });
      if (first.ok) expect(first.meta).toMatchObject({ fellBack: true, mode: "json_object" });
      // observable: el log operativo lo dice, sin contenido
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("event=format_fallback");
      expect(logged).toContain("json_schema_a_json_object");

      // el siguiente turno YA empieza en json_object: sin pagar la bajada otra vez
      const second = await ask();
      expect(second.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(bodyOf(fetchMock, 2).response_format).toEqual({ type: "json_object" });
    });

    it("auto: puede bajar hasta sin formato (último recurso, explícito y dentro del presupuesto)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unsupportedFormat())
        .mockResolvedValueOnce(unsupportedFormat())
        .mockImplementation(() => Promise.resolve(providerResponse(REPLY_OK)));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(bodyOf(fetchMock, 2).response_format).toBeUndefined();
      expect(bodyOf(fetchMock, 2).provider).toBeUndefined();
    });

    it("el 404 de OpenRouter con require_parameters (sin código propio) sí cuenta como formato no soportado", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code: 404,
                message:
                  "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
              },
            }),
            { status: 404 }
          )
        )
        .mockImplementation(() => Promise.resolve(providerResponse(REPLY_OK)));
      vi.stubGlobal("fetch", fetchMock);
      expect((await ask()).ok).toBe(true);
      expect(bodyOf(fetchMock, 1).response_format).toEqual({ type: "json_object" });
    });

    for (const status of [400, 404, 422]) {
      it(`un ${status} GENÉRICO no degrada en silencio: invalid_request, UNA llamada, sin bajada de nivel`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchMock = vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ error: { message: "Bad Request" } }), { status }));
        vi.stubGlobal("fetch", fetchMock);
        const result = await ask();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe("invalid_request");
          expect(result.status).toBe(status);
        }
        expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("format_fallback");
      });
    }

    it("un 400 con cuerpo NO JSON (proxy, HTML) tampoco degrada", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("<html>Bad gateway?</html>", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("invalid_request");
    });

    it("nuestro esquema rechazado → schema_rejected (bug, no capacidad), sin bajar de nivel", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid schema for response_format 'x': 'additionalProperties' is required",
              type: "invalid_request_error",
              param: "response_format",
              code: "invalid_json_schema",
            },
          }),
          { status: 400 }
        )
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("schema_rejected");
    });

    it("modelo inexistente → model_not_found, sin bajar de nivel", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 400, message: "modelo-inventado is not a valid model ID" } }),
          { status: 400 }
        )
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("model_not_found");
    });

    it("el cuerpo del error del proveedor nunca llega a `detail`", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "echo: MENSAJE-DEL-CLIENTE" } }), { status: 400 })
        )
      );
      const result = await ask();
      if (!result.ok) expect(result.detail).not.toContain("MENSAJE-DEL-CLIENTE");
    });

    it("valor FIJO: sin escalera; rechazo explícito → unsupported_response_format, una llamada", async () => {
      vi.stubEnv("AI_RESPONSE_FORMAT", "json_schema");
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(unsupportedFormat()));
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("unsupported_response_format");
    });

    it("valor FIJO + 400 genérico → invalid_request (no se disfraza de incompatibilidad de formato)", async () => {
      vi.stubEnv("AI_RESPONSE_FORMAT", "json_schema");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 400 })));
      const result = await ask();
      if (!result.ok) expect(result.error).toBe("invalid_request");
    });
  });

  // ─── presupuesto de llamadas (invariante I1) ───────────────────────

  describe("presupuesto de llamadas compartido", () => {
    it("por defecto una invocación nunca hace más de 3 llamadas, sea cual sea la mezcla", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("x", { status: 503 })));
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("reintentos de transporte y bajada de formato comparten el MISMO presupuesto", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unsupportedFormat()) // 1: baja a json_object
        .mockResolvedValueOnce(unsupportedFormat()) // 2: baja a sin formato
        .mockImplementation(() => Promise.resolve(new Response("x", { status: 500 }))); // 3: 500
      vi.stubGlobal("fetch", fetchMock);
      const pending = ask();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(3); // no hay 4ª: el reintento del 500 no cabe
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("provider_error");
    });

    it("el presupuesto pasado se DECREMENTA con cada llamada real (lo comparten quienes lo reciben)", async () => {
      const { createCallBudget } = await import("@/lib/ai/budget");
      const budget = createCallBudget(3);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(REPLY_OK)));
      await chatJson(schema, [{ role: "user", content: "hola" }], { budget });
      expect(budget.remaining).toBe(2);
    });

    it("con 1 llamada restante NO hay reintento ni espera: falla de inmediato con el error real", async () => {
      const { createCallBudget } = await import("@/lib/ai/budget");
      const budget = createCallBudget(1);
      const fetchMock = vi.fn().mockResolvedValue(new Response("x", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [{ role: "user", content: "hola" }], { budget });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("provider_error");
      expect(budget.remaining).toBe(0);
    });

    it("con 1 llamada restante tampoco hay corrección por formato", async () => {
      const { createCallBudget } = await import("@/lib/ai/budget");
      const fetchMock = vi.fn().mockResolvedValue(providerResponse("prosa"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [{ role: "user", content: "hola" }], {
        budget: createCallBudget(1),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (!result.ok) expect(result.error).toBe("invalid_json");
    });

    it("presupuesto agotado antes de empezar: cero llamadas", async () => {
      const { createCallBudget } = await import("@/lib/ai/budget");
      const budget = createCallBudget(3);
      budget.remaining = 0;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(schema, [{ role: "user", content: "hola" }], { budget });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });

    it("sólo problemas de formato: máximo 2 llamadas (principal + una corrección)", async () => {
      for (const first of ["prosa", '{"action":"x"}']) {
        const fetchMock = vi
          .fn()
          .mockImplementation(() => Promise.resolve(providerResponse(first)));
        vi.stubGlobal("fetch", fetchMock);
        await ask();
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
      }
    });

    it("la transcripción tiene su propio tope de 2 (cada llamada sube el audio)", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("x", { status: 500 })));
      vi.stubGlobal("fetch", fetchMock);
      const pending = transcribeAudio({ data: Buffer.from("a"), mimeType: "audio/ogg" });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ─── configuración ─────────────────────────────────────────────────

  describe("configuración", () => {
    it("sin token → not_configured sin tocar la red", async () => {
      vi.stubEnv("OPENROUTER_API_TOKEN", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await ask();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("not_configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("un token de organización pisa el de entorno y viaja sólo en el header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(REPLY_OK));
      vi.stubGlobal("fetch", fetchMock);
      await chatJson(schema, [{ role: "user", content: "hola" }], {
        apiToken: "token-de-la-org",
        model: "modelo-de-la-org",
      });
      const init = fetchMock.mock.calls[0]![1]!;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-de-la-org"
      );
      expect(init.body as string).not.toContain("token-de-la-org");
      expect(bodyOf(fetchMock, 0).model).toBe("modelo-de-la-org");
    });
  });

  // ─── privacidad ────────────────────────────────────────────────────

  describe("privacidad: nada del cliente ni del modelo llega a logs ni a detail", () => {
    it("ningún console.* ni detail contiene la conversación, la salida del modelo, el token ni el cuerpo del proveedor", async () => {
      vi.useFakeTimers();
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {})
      );
      const CLIENTE = "MENSAJE-PRIVADO-DEL-PROSPECTO 5512345678";
      const MODELO = "SALIDA-DEL-MODELO-CON-DATOS-DEL-CLIENTE";
      const CUERPO = "CUERPO-DE-ERROR-DEL-PROVEEDOR";
      const details: string[] = [];

      const scenarios: (() => ReturnType<typeof vi.fn>)[] = [
        () => vi.fn().mockResolvedValue(providerResponse(MODELO)), // invalid_json
        () => vi.fn().mockResolvedValue(providerResponse(`{"action":"${MODELO}"}`)), // invalid_schema
        () => vi.fn().mockResolvedValue(new Response(CUERPO, { status: 500 })),
        () => vi.fn().mockResolvedValue(new Response(CUERPO, { status: 401 })),
        () => vi.fn().mockResolvedValue(new Response(CUERPO, { status: 429 })),
        () => vi.fn().mockRejectedValue(new TypeError(`fetch failed ${CLIENTE}`)),
      ];
      for (const make of scenarios) {
        resetResponseFormatMemory();
        vi.stubGlobal("fetch", make());
        const pending = chatJson(
          schema,
          [{ role: "user", content: CLIENTE }],
          { traceId: "cv_correlacion" }
        );
        await vi.advanceTimersByTimeAsync(10_000);
        const r = await pending;
        if (!r.ok) details.push(r.detail);
      }

      const everything = [
        ...spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))),
        ...details,
      ].join("\n");
      for (const secreto of [CLIENTE, MODELO, CUERPO, "token-test", "5512345678"]) {
        expect(everything).not.toContain(secreto);
      }
      // sí quedan los datos operativos mínimos, correlacionables
      expect(everything).toContain("traceId=cv_correlacion");
      expect(everything).toContain("model=modelo-test");
      expect(everything).toContain("route=openrouter.ai");
      expect(everything).toMatch(/durationMs=\d+/);
      expect(everything).toMatch(/outcome=/);
    });
  });

  // ─── consumidores que NO piden JSON del agente ─────────────────────

  describe("testAiCredentials (texto libre)", () => {
    it("manda SÓLO { model, messages }: ni response_format ni provider", async () => {
      const fetchMock = vi.fn().mockResolvedValue(providerResponse("ok"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await testAiCredentials({ apiToken: "tk", model: "m" });
      expect(result).toEqual({ ok: true });
      expect(Object.keys(bodyOf(fetchMock, 0)).sort()).toEqual(["messages", "model"]);
    });

    it("token rechazado → ok:false con el motivo legible para el operador, una sola llamada", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("Invalid API key", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await testAiCredentials({ apiToken: "malo", model: "m" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("401");
    });
  });

  describe("transcripción de audio", () => {
    const audio = { data: Buffer.from("audio"), mimeType: "audio/ogg" };

    it("pide {text} estructurado y devuelve la transcripción", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(providerResponse('{"text":"hola, quiero información"}'));
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeAudio(audio);
      expect(result).toEqual({ ok: true, text: "hola, quiero información" });
      expect(bodyOf(fetchMock, 0).response_format.type).toBe("json_schema");
      // el audio viaja en la petición (input_audio) — una vez
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("si el modelo no obedece el JSON NO se reenvía el audio: 1 llamada, error fijo sin la transcripción", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(providerResponse("lo que dijo el cliente en su nota de voz"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeAudio(audio);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain("nota de voz");
    });

    it("sin voz entendible → error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse('{"text":"  "}')));
      expect(await transcribeAudio(audio)).toEqual({
        ok: false,
        error: "sin voz entendible",
      });
    });
  });

  describe("juez del Laboratorio", () => {
    it("el veredicto se pide estructurado (Verdict → json_schema) y se valida", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(providerResponse('{"veredicto":"verde","hallazgos":[]}'));
      vi.stubGlobal("fetch", fetchMock);
      const result = await chatJson(Verdict, [{ role: "user", content: "evalúa" }], {
        judge: true,
        schemaName: "veredicto_juez",
      });
      expect(result.ok).toBe(true);
      const rf = bodyOf(fetchMock, 0).response_format;
      expect(rf.type).toBe("json_schema");
      expect(rf.json_schema.schema.properties.veredicto.enum).toEqual([
        "verde",
        "amarillo",
        "rojo",
      ]);
    });
  });
});
