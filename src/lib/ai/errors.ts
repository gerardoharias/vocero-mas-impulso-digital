/**
 * Clasificación explícita de fallos del adaptador LLM (spec 023, D4).
 *
 * Vive en su propio módulo, sin dependencias, para que quien decide qué hacer
 * con un fallo (pipeline, juez) no dependa de `@/lib/ai` (que los tests mockean
 * completo) y para que NADIE clasifique buscando palabras en un mensaje.
 */

export type AiErrorCode =
  /** Sin token o sin modelo configurado. */
  | "not_configured"
  /** HTTP 401/403: el proveedor rechaza la credencial. */
  | "unauthorized"
  /** El proveedor DICE (por código/parámetro estructurado) que no soporta el `response_format` pedido. */
  | "unsupported_response_format"
  /** El proveedor rechazó NUESTRO JSON Schema (bug/regresión del conversor, no capacidad del modelo). */
  | "schema_rejected"
  /** El modelo configurado no existe o no tiene endpoints. */
  | "model_not_found"
  /** 400/404/422 sin señal de causa: petición defectuosa, endpoint equivocado o regresión. */
  | "invalid_request"
  /** HTTP 429. */
  | "rate_limited"
  /** La llamada superó `timeoutMs`. */
  | "timeout"
  /** `fetch` rechazó (DNS, conexión reseteada…). */
  | "network_error"
  /** 5xx, 402, otros 4xx, `error` dentro de un 200, respuesta sin contenido. */
  | "provider_error"
  /** Hubo texto pero no un objeto JSON extraíble. */
  | "invalid_json"
  /** Hubo un objeto JSON pero no cumple el esquema Zod. */
  | "invalid_schema";

/**
 * - `config`: reintentar no lo arregla; alguien tiene que cambiar algo.
 * - `transport`: el proveedor/red falló (transitorio o persistente).
 * - `format`: el proveedor respondió, pero no con el contrato pedido.
 */
export type AiErrorClass = "config" | "transport" | "format";

export function errorClass(code: AiErrorCode): AiErrorClass {
  switch (code) {
    case "not_configured":
    case "unauthorized":
    case "unsupported_response_format":
    case "schema_rejected":
    case "model_not_found":
    case "invalid_request":
      return "config";
    case "invalid_json":
    case "invalid_schema":
      return "format";
    case "rate_limited":
    case "timeout":
    case "network_error":
    case "provider_error":
      return "transport";
  }
}
