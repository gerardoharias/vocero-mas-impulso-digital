import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatJson, extractJson } from "@/lib/ai";

describe("extractJson (extracción robusta)", () => {
  it("JSON limpio", () => {
    expect(extractJson('{"action":"none"}')).toEqual({ action: "none" });
  });

  it("bloque ```json con texto alrededor", () => {
    const raw = 'Claro, aquí está:\n```json\n{"action":"reply","text":"hola"}\n```\nEspero que sirva.';
    expect(extractJson(raw)).toEqual({ action: "reply", text: "hola" });
  });

  it("JSON incrustado en prosa (primer { al último })", () => {
    const raw = 'La acción que tomaré es {"action":"handoff","reason":"cliente"} por lo dicho.';
    expect(extractJson(raw)).toEqual({ action: "handoff", reason: "cliente" });
  });

  it("sin JSON → null", () => {
    // El RESCATE de esa prosa no vive aquí, sino en `server/ai/salvage.ts`:
    // este adaptador es genérico sobre cualquier esquema Zod (el juez del
    // Laboratorio y la transcripción no tienen ninguna acción `reply` que
    // envolver). Este test es el que impide que alguien vuelva a meter
    // política de producto en el adaptador.
    expect(extractJson("no tengo nada que decir")).toBeNull();
  });
});

describe("chatJson (reintentos y errores tipados)", () => {
  const schema = z.object({ action: z.literal("reply"), text: z.string() });

  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    // La memoria de "este modelo no soporta json mode" vive en globalThis.
    delete (globalThis as { __aiNoJsonMode?: unknown }).__aiNoJsonMode;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function providerResponse(content: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  it("salida inválida al primer intento → reintenta con STRICT y triunfa", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerResponse("no soy json"))
      .mockResolvedValueOnce(providerResponse('{"action":"reply","text":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // el reintento agrega la instrucción STRICT
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(JSON.stringify(secondBody.messages)).toContain("STRICT");
  });

  it("proveedor caído (500 persistente) → error tipado, jamás excepción", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("boom", { status: 500 }))
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("provider_error");
    expect(fetchMock).toHaveBeenCalledTimes(3); // agotó los 3 intentos
  });

  it("salida que nunca cumple el esquema → invalid_output", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(providerResponse('{"action":"otra_cosa"}'))
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_output");
  });

  it("prosa persistente → invalid_output CON el raw completo para rescatarlo", async () => {
    // El incidente: el modelo contestó bien pero sin JSON. Ese texto es lo que
    // el pipeline necesita para no dejar al cliente colgado, así que el
    // resultado tiene que llevarlo ENTERO (no truncado, como en `detail`).
    const prosa =
      "Eso no te lo puedo decir, solo me enfoco en temas de este negocio 🙂 " +
      "x".repeat(400);
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(providerResponse(prosa)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_output");
      expect(result.raw).toBe(prosa);
    }
  });

  it("proveedor caído → SIN raw: esa ausencia es la señal de que no hay nada que rescatar", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("boom", { status: 500 }))
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBeUndefined();
  });

  it("un 500 cuyo cuerpo menciona JSON sigue siendo provider_error", async () => {
    // Regresión: la clasificación se hacía buscando la palabra "JSON" en el
    // mensaje de error, así que una caída del proveedor se contaba como culpa
    // del modelo.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('{"error":"Invalid JSON in request body"}', { status: 500 })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("provider_error");
  });

  it("por defecto pide el JSON por contrato de API (response_format)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(providerResponse('{"action":"reply","text":"ok"}'))
      );
    vi.stubGlobal("fetch", fetchMock);

    await chatJson(schema, [{ role: "user", content: "hola" }]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("modelo que no soporta json mode → reintenta sin él y lo recuerda", async () => {
    // Una Response nueva por llamada: su body solo se puede leer una vez.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: "No endpoints found that support JSON mode" },
            }),
            { status: 404 }
          )
        )
      )
      .mockImplementation(() =>
        Promise.resolve(providerResponse('{"action":"reply","text":"ok"}'))
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(retryBody.response_format).toBeUndefined();

    // Y no se vuelve a pagar el rechazo: la segunda llamada ya va sin el campo.
    fetchMock.mockClear();
    const second = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const laterBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(laterBody.response_format).toBeUndefined();
  });

  it("un 429 NO se confunde con un rechazo de json mode", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response("rate limit exceeded, response_format", { status: 429 })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("provider_error");
    // 3 intentos del bucle, no un fallback silencioso a "sin json mode".
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sin token → not_configured sin tocar la red", async () => {
    vi.stubEnv("OPENROUTER_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(schema, [{ role: "user", content: "hola" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
