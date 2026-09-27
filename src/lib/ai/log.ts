/**
 * Logs operativos del adaptador de IA (spec 023, D8).
 *
 * Lista blanca de campos: el tipo NO admite un `string` libre para contenido.
 * Nunca entra aquí (ni en `detail`): la respuesta del modelo, el prompt, los
 * mensajes del cliente, teléfonos, tokens, cuerpos de error del proveedor.
 */

export type AiLogEvent = {
  event:
    | "chat_result"
    | "provider_call_failed"
    | "format_fallback"
    | "recovery"
    | "turn_outcome"
    | "circuit_open"
    | "circuit_blocked"
    | "circuit_closed"
    | "action_guard";
  /** Identificador interno correlacionable (id de conversación), nunca PII. */
  traceId?: string;
  /** Id interno de la organización (nunca su nombre ni datos de contacto). */
  org?: string;
  model?: string;
  /** Host del proveedor (y, si lo informó, el proveedor servido). */
  route?: string;
  attempt?: number;
  mode?: "json_schema" | "json_object" | "none";
  fallback?: boolean;
  corrected?: boolean;
  durationMs?: number;
  status?: number;
  code?: string;
  outcome?: string;
  recovered?: string;
  failures?: number;
  cooldownSec?: number;
};

const SAFE_VALUE = /^[\w./:@+-]{1,80}$/;

function fmt(value: unknown): string {
  const s = String(value);
  // Defensa en profundidad: aunque el tipo no lo permite, un valor con
  // espacios/saltos/comillas (o sea, texto libre) jamás se escribe tal cual.
  return SAFE_VALUE.test(s) ? s : "[omitido]";
}

export function logAi(
  level: "info" | "warn" | "error",
  e: AiLogEvent
): void {
  const parts = ["[ia]"];
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmt(v)}`);
  }
  console[level](parts.join(" "));
}

/**
 * Descripción segura de una excepción para logs: nombre y código, NUNCA el
 * mensaje. Los errores de BD (parámetros de la consulta) y de Meta (números de
 * teléfono en el cuerpo) traen contenido del cliente dentro de `message`.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const safeCode =
      typeof code === "string" || typeof code === "number" ? `:${fmt(code)}` : "";
    return `${fmt(err.name)}${safeCode}`;
  }
  return "no_error_object";
}
