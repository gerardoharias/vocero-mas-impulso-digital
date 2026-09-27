import { describe, expect, it } from "vitest";
import { classifyRejection, parseErrorBody } from "@/lib/ai/rejection";
import { errorClass } from "@/lib/ai/errors";

/**
 * Sólo una señal EXPLÍCITA de "no soporto ese formato" puede bajar el nivel de
 * response_format. Todo lo demás es un error visible (spec 023 §3.1).
 */
describe("classifyRejection", () => {
  describe("formato realmente no soportado", () => {
    const casos: [string, unknown][] = [
      [
        "OpenAI: param response_format",
        { message: "x", type: "invalid_request_error", param: "response_format", code: null },
      ],
      ["param anidado", { param: "response_format.json_schema", message: "x" }],
      ["código dedicado", { code: "unsupported_response_format", message: "x" }],
      ["código de structured output", { code: "unsupported_structured_output" }],
      [
        "OpenRouter require_parameters (404 sin código propio)",
        {
          code: 404,
          message:
            "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
        },
      ],
      [
        "frase que nombra el formato Y dice que no se soporta",
        { message: "The response_format json_schema is not supported by this model" },
      ],
    ];
    for (const [nombre, body] of casos) {
      it(nombre, () => expect(classifyRejection(body)).toBe("format_unsupported"));
    }
  });

  describe("esquema rechazado (bug nuestro, no capacidad)", () => {
    it("código invalid_json_schema aunque el param sea response_format", () => {
      expect(
        classifyRejection({ code: "invalid_json_schema", param: "response_format", message: "x" })
      ).toBe("schema_rejected");
    });
    it("mensaje 'Invalid schema for response_format' (nombra el formato, pero NO es capacidad)", () => {
      expect(
        classifyRejection({
          message: "Invalid schema for response_format 'x': 'minLength' is not permitted",
        })
      ).toBe("schema_rejected");
    });
  });

  describe("modelo inexistente", () => {
    it("código model_not_found", () => {
      expect(classifyRejection({ code: "model_not_found" })).toBe("model_not_found");
    });
    it("OpenRouter: 'is not a valid model ID'", () => {
      expect(classifyRejection({ code: 400, message: "foo/bar is not a valid model ID" })).toBe(
        "model_not_found"
      );
    });
    it("OpenRouter: 'No endpoints found for <modelo>' NO se confunde con require_parameters", () => {
      expect(classifyRejection({ code: 404, message: "No endpoints found for foo/bar." })).toBe(
        "model_not_found"
      );
    });
  });

  describe("genérico / petición inválida → conservador (no se degrada)", () => {
    const casos: [string, unknown][] = [
      ["sin cuerpo", undefined],
      ["cuerpo vacío", {}],
      ["mensaje genérico", { message: "Bad Request" }],
      ["contexto excedido", { message: "This model's maximum context length is 8192 tokens" }],
      ["parámetro ajeno no soportado", { param: "temperature", code: "unsupported_value", message: "x" }],
      ["menciona 'not supported' pero no el formato", { message: "Feature X is not supported" }],
      ["menciona el formato pero no dice que no se soporta", { message: "response_format looks fine" }],
      ["no es un objeto", "boom"],
      ["nulo", null],
    ];
    for (const [nombre, body] of casos) {
      it(nombre, () => expect(classifyRejection(body)).toBe("invalid_request"));
    }
  });
});

describe("parseErrorBody", () => {
  it("extrae `error` de un cuerpo JSON", () => {
    expect(parseErrorBody('{"error":{"code":"x"}}')).toEqual({ code: "x" });
  });
  it("cuerpo no JSON o sin `error` → undefined, sin lanzar", () => {
    expect(parseErrorBody("<html>")).toBeUndefined();
    expect(parseErrorBody('{"foo":1}')).toBeUndefined();
    expect(parseErrorBody("")).toBeUndefined();
  });
});

describe("clases de los códigos nuevos", () => {
  it("schema_rejected, model_not_found e invalid_request son de configuración (no se reintentan ni se ocultan)", () => {
    for (const c of ["schema_rejected", "model_not_found", "invalid_request"] as const) {
      expect(errorClass(c)).toBe("config");
    }
  });
});
