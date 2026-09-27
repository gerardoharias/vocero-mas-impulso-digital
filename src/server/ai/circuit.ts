import { errorClass, type AiErrorCode } from "@/lib/ai/errors";
import { logAi } from "@/lib/ai/log";

/**
 * Circuito de protección por organización + modelo (spec 023 §3.7).
 *
 * Problema: una configuración global rota (token revocado, modelo inexistente,
 * formato incompatible, proveedor caído) hacía que CADA conversación pagara sus
 * llamadas fallidas y terminara en su propio handoff `error`, apagando la IA en
 * todas. Un fallo AISLADO de una conversación es otra cosa: eso lo cubre el
 * estado por conversación (`failure-state.ts`).
 *
 * Política:
 * - Cuentan sólo fallos GLOBALES: de configuración (`unauthorized`,
 *   `model_not_found`, `schema_rejected`, `invalid_request`,
 *   `unsupported_response_format`) o de transporte ya agotados. NUNCA los de
 *   formato (son por mensaje) ni `not_configured`.
 * - Se abre tras N fallos seguidos SIN un solo éxito en el medio y desde ≥ 2
 *   conversaciones distintas: 2 para configuración (determinista), 3 para
 *   transporte (puede ser un bache). Un éxito lo cierra y borra la cuenta.
 * - Abierto: los turnos NO llaman al proveedor (cero costo), NO hacen handoff
 *   y la conversación queda recuperable (la IA sigue activa). Cada
 *   conversación recibe UNA vez el mensaje fijo de degradación por periodo, que
 *   no promete un humano.
 * - Tras el enfriamiento (5 min, ×2 en cada reapertura, tope 30) pasa a
 *   semiabierto: UN turno de prueba; si sale bien cierra, si falla reabre.
 * - Señal operativa: logs `circuit_open` / `circuit_blocked` /
 *   `circuit_closed` con organización, modelo, código, conteo y enfriamiento;
 *   nada de contenido. Un `unauthorized` además marca la conexión de la
 *   organización como `error` (Ajustes → IA lo muestra).
 *
 * Estado en memoria del proceso: la app es un monolito por negocio (constit.
 * II, sin colas externas). Con varias réplicas cada una abre el suyo; un
 * reinicio lo cierra y se reabre tras el mismo número de fallos — la
 * corrección (contador por conversación) está en la base, esto es sólo
 * protección de costo.
 */

export const CIRCUIT = {
  configThreshold: 2,
  transportThreshold: 3,
  /** Los fallos más viejos que esto no suman: no es una racha. */
  windowMs: 10 * 60_000,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 30 * 60_000,
  /** Si el turno de prueba nunca reporta (excepción), otro puede probar tras esto. */
  probeTimeoutMs: 2 * 60_000,
} as const;

type State = {
  failures: number;
  conversations: Set<string>;
  windowStart: number;
  openUntil: number;
  trips: number;
  probing: boolean;
  probeAt: number;
  lastCode: string;
};

const globalForCircuit = globalThis as unknown as {
  __aiCircuit?: Map<string, State>;
};
function states(): Map<string, State> {
  globalForCircuit.__aiCircuit ??= new Map();
  return globalForCircuit.__aiCircuit;
}

/** Sólo para pruebas. */
export function resetCircuitState(): void {
  globalForCircuit.__aiCircuit = new Map();
}

const keyOf = (organizationId: string, model: string) => `${organizationId}|${model}`;

export type CircuitGate =
  | { allow: true; probe: boolean }
  | { allow: false; code: string; retryAtMs: number };

/** ¿Este código de fallo puede indicar un problema GLOBAL (y no de un mensaje)? */
export function countsTowardCircuit(code: AiErrorCode): boolean {
  if (code === "not_configured") return false;
  return errorClass(code) !== "format";
}

export function circuitCheck(
  organizationId: string,
  model: string,
  now: number = Date.now()
): CircuitGate {
  const s = states().get(keyOf(organizationId, model));
  if (!s || s.openUntil === 0) return { allow: true, probe: false };
  if (now < s.openUntil) {
    return { allow: false, code: s.lastCode, retryAtMs: s.openUntil };
  }
  // Enfriamiento cumplido → semiabierto: UN turno de prueba a la vez.
  if (s.probing && now - s.probeAt < CIRCUIT.probeTimeoutMs) {
    return {
      allow: false,
      code: s.lastCode,
      retryAtMs: s.probeAt + CIRCUIT.probeTimeoutMs,
    };
  }
  s.probing = true;
  s.probeAt = now;
  return { allow: true, probe: true };
}

/** Un turno llegó al proveedor y volvió con algo utilizable: la racha termina. */
export function circuitRecordSuccess(organizationId: string, model: string): void {
  const k = keyOf(organizationId, model);
  const s = states().get(k);
  if (!s) return;
  const wasOpen = s.openUntil !== 0;
  states().delete(k);
  if (wasOpen) {
    logAi("info", { event: "circuit_closed", org: organizationId, model });
  }
}

export type CircuitFailureResult = { opened: boolean; failures: number };

/** Registra un fallo global. Llamar sólo si `countsTowardCircuit(code)`. */
export function circuitRecordFailure(
  organizationId: string,
  model: string,
  conversationId: string,
  code: AiErrorCode,
  now: number = Date.now()
): CircuitFailureResult {
  const k = keyOf(organizationId, model);
  let s = states().get(k);
  if (!s) {
    s = {
      failures: 0,
      conversations: new Set(),
      windowStart: now,
      openUntil: 0,
      trips: 0,
      probing: false,
      probeAt: 0,
      lastCode: code,
    };
    states().set(k, s);
  }
  s.lastCode = code;

  const open = () => {
    s.trips++;
    const cooldown = Math.min(
      CIRCUIT.baseCooldownMs * 2 ** (s.trips - 1),
      CIRCUIT.maxCooldownMs
    );
    s.openUntil = now + cooldown;
    s.probing = false;
    logAi("error", {
      event: "circuit_open",
      org: organizationId,
      model,
      code,
      failures: s.failures,
      cooldownSec: Math.round(cooldown / 1000),
    });
  };

  if (s.probing) {
    // El turno de prueba falló: se reabre con un enfriamiento mayor.
    s.failures++;
    open();
    return { opened: true, failures: s.failures };
  }

  if (now - s.windowStart > CIRCUIT.windowMs && s.openUntil === 0) {
    s.failures = 0;
    s.conversations = new Set();
    s.windowStart = now;
  }
  s.failures++;
  s.conversations.add(conversationId);
  const threshold =
    errorClass(code) === "config" ? CIRCUIT.configThreshold : CIRCUIT.transportThreshold;
  if (s.openUntil === 0 && s.failures >= threshold && s.conversations.size >= 2) {
    open();
    return { opened: true, failures: s.failures };
  }
  return { opened: false, failures: s.failures };
}
