/**
 * Clasificación de un 400/404/422 del proveedor (spec 023 §3.1).
 *
 * Bajar `json_schema → json_object → sin formato` esconde el problema si la
 * causa NO era la capacidad del modelo (esquema inválido, modelo inexistente,
 * petición defectuosa, un bug nuestro). Por eso sólo se baja ante una señal
 * EXPLÍCITA de "no soporto ese formato", y todo lo demás es un error visible.
 *
 * Orden de evidencia (de más a menos fiable):
 *   1. campos ESTRUCTURADOS del cuerpo de error (`code`, `type`, `param`);
 *   2. frases fijas y documentadas de OpenRouter (su 404 con
 *      `require_parameters` no trae código propio);
 *   3. nada: `invalid_request` (conservador — no se baja de formato).
 * El texto del error se usa SÓLO para compararlo contra esas frases: no se
 * guarda ni se registra (puede citar la petición).
 */

export type Rejection =
  | "format_unsupported"
  | "schema_rejected"
  | "model_not_found"
  | "invalid_request";

type ErrorBody = {
  code?: unknown;
  type?: unknown;
  param?: unknown;
  message?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const SCHEMA_CODES = /invalid_json_schema|invalid_schema/i;
const SCHEMA_MESSAGE = /\binvalid schema\b/i;

const FORMAT_CODES = new Set([
  "unsupported_response_format",
  "unsupported_structured_output",
]);
const FORMAT_PARAM = /^(response_format|structured_outputs)(\.|$|\[)/i;
/** 404 de OpenRouter cuando `provider.require_parameters` no encuentra endpoint. */
const OPENROUTER_NO_PARAM_ENDPOINT =
  /no endpoints found that can handle the requested parameters/i;
const FORMAT_TOKENS = /response_format|json_schema|json_object|structured output/i;
const UNSUPPORTED_TOKENS = /not supported|unsupported|does not support|not available/i;

const MODEL_CODES = new Set(["model_not_found"]);
const MODEL_PHRASES = [/is not a valid model id/i, /no endpoints found for\b/i];

export function classifyRejection(errorBody: unknown): Rejection {
  const e: ErrorBody =
    errorBody !== null && typeof errorBody === "object" ? (errorBody as ErrorBody) : {};
  const code = str(e.code);
  const type = str(e.type);
  const param = str(e.param);
  const message = str(e.message);

  // 1. Nuestro esquema fue rechazado: es un bug, no una capacidad.
  if (SCHEMA_CODES.test(code) || SCHEMA_CODES.test(type) || SCHEMA_MESSAGE.test(message)) {
    return "schema_rejected";
  }
  // 2. Formato no soportado: señal estructurada primero.
  if (FORMAT_CODES.has(code) || FORMAT_PARAM.test(param)) return "format_unsupported";
  if (OPENROUTER_NO_PARAM_ENDPOINT.test(message)) return "format_unsupported";
  // 3. Modelo inexistente (después del caso anterior: ambos dicen "No endpoints found…").
  if (MODEL_CODES.has(code) || MODEL_CODES.has(type)) return "model_not_found";
  if (MODEL_PHRASES.some((p) => p.test(message))) return "model_not_found";
  // 4. Un mensaje que nombra el formato Y dice que no se soporta (ambos, en el mismo texto).
  if (FORMAT_TOKENS.test(message) && UNSUPPORTED_TOKENS.test(message)) {
    return "format_unsupported";
  }
  // 5. Conservador: no se sabe → no se degrada.
  return "invalid_request";
}

/** Extrae `error` de un cuerpo de respuesta sin lanzar. */
export function parseErrorBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      return (parsed as { error: unknown }).error;
    }
  } catch {
    // cuerpo no JSON (proxy, HTML…): sin señal estructurada
  }
  return undefined;
}
