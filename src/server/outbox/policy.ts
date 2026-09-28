/**
 * 024 — Política de errores y de reintentos del envío saliente. PURA: sin BD,
 * sin reloj implícito, sin red — se prueba sola (tests/unit/outbox-policy.test.ts).
 *
 * Se decide por CÓDIGO DE META + ETAPA + señal de red. Nunca por el texto del
 * error (Meta lo traduce y lo cambia) y nunca sólo por el HTTP status.
 *
 * Regla de oro: un fallo es reintentable sólo si Meta dijo, sin ambigüedad, que
 * NO aceptó el mensaje y que la causa es pasajera. La Cloud API no ofrece
 * clave de idempotencia: reenviar tras un resultado ambiguo puede entregar dos
 * veces. Ante la duda, `delivery_unknown` y decisión humana.
 */

export type FailureClass =
  | "transient"
  | "rate_limit"
  | "ambiguous"
  | "window_closed"
  | "recipient_unavailable"
  | "auth"
  | "permanent"
  /**
   * No viene de Meta: el mensaje ofrecía horarios que el sistema ya sabe que
   * dejaron de estar libres (o su ronda quedó obsoleta). No se envía (spec 024
   * §5.6). `classifyFailure` nunca la devuelve.
   */
  | "offer_stale";

/** Etapa en la que se observó el fallo. */
export type FailureStage = "sync" | "async";

/**
 * Cómo falló la conexión cuando NO hubo respuesta HTTP:
 * - `connect`: la petición nunca llegó a Meta (DNS, conexión rechazada) ⇒ seguro reintentar.
 * - `timeout` / `unknown`: pudo haber llegado ⇒ ambiguo.
 */
export type NetworkPhase = "connect" | "timeout" | "unknown";

export type FailureSignal = {
  stage: FailureStage;
  /** Código numérico de `error.code` (síncrono) o `errors[0].code` (estado). */
  code?: number | null;
  subcode?: number | null;
  /** HTTP status de la respuesta; 0/nulo si no la hubo. */
  httpStatus?: number | null;
  network?: NetworkPhase | null;
  /** 200 sin `messages[0].id`: Meta pudo haber aceptado el mensaje. */
  noMessageId?: boolean;
};

export type Classification = {
  class: FailureClass;
  /** Se puede reintentar automáticamente. */
  retryable: boolean;
  /** No se sabe si Meta lo aceptó: NO se reenvía solo. */
  ambiguous: boolean;
};

/* ---------- Lista de códigos (conservadora y explícita) ---------- */

/** Fallos pasajeros de Meta: el mensaje NO se aceptó y basta esperar. */
export const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  2, // API Service: servicio temporalmente no disponible
  131016, // Service unavailable
  133004, // Server temporarily unavailable
  131057, // Cuenta en modo mantenimiento
]);

/** Límites de frecuencia: reintentables con espera mayor. */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  4, // API Too Many Calls (app)
  80007, // Rate limit a nivel WABA
  130429, // Throughput de la Cloud API
  131056, // Demasiados mensajes al mismo usuario en poco tiempo (par negocio-usuario)
]);

/** Ventana de 24 h cerrada: sólo se reabre con una plantilla. */
export const WINDOW_CLOSED_CODES: ReadonlySet<number> = new Set([131047]);

/** El destinatario no puede recibir: reintentar sólo repite el rechazo. */
export const RECIPIENT_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([
  131026, // Undeliverable
  131030, // Destinatario fuera de la lista de permitidos (modo de prueba)
  131021, // El destinatario es el propio remitente
]);

/** Token vencido o revocado. */
export const AUTH_CODES: ReadonlySet<number> = new Set([190]);

const OUTCOME: Record<Exclude<FailureClass, "offer_stale">, Classification> = {
  transient: { class: "transient", retryable: true, ambiguous: false },
  rate_limit: { class: "rate_limit", retryable: true, ambiguous: false },
  ambiguous: { class: "ambiguous", retryable: false, ambiguous: true },
  window_closed: { class: "window_closed", retryable: false, ambiguous: false },
  recipient_unavailable: {
    class: "recipient_unavailable",
    retryable: false,
    ambiguous: false,
  },
  auth: { class: "auth", retryable: false, ambiguous: false },
  permanent: { class: "permanent", retryable: false, ambiguous: false },
};

/**
 * Clasifica un fallo. El orden de las reglas ES la política:
 *  1. token (190 / 401)            → auth
 *  2. código de Meta conocido      → su clase (el código manda sobre el HTTP)
 *  3. `200` sin id                 → ambiguo
 *  4. sin código, sin respuesta    → connect: transitorio · resto: ambiguo
 *  5. sin código, con respuesta    → 429 rate_limit · 503 transitorio · 5xx ambiguo · 4xx permanente
 *  6. código de Meta desconocido   → 5xx con código 1 transitorio · resto permanente
 */
export function classifyFailure(signal: FailureSignal): Classification {
  const { code, httpStatus, network } = signal;
  const status = httpStatus ?? 0;

  if (code === 190 || status === 401) return OUTCOME.auth;

  if (code != null) {
    if (AUTH_CODES.has(code)) return OUTCOME.auth;
    if (WINDOW_CLOSED_CODES.has(code)) return OUTCOME.window_closed;
    if (RECIPIENT_UNAVAILABLE_CODES.has(code)) return OUTCOME.recipient_unavailable;
    if (RATE_LIMIT_CODES.has(code)) return OUTCOME.rate_limit;
    if (TRANSIENT_CODES.has(code)) return OUTCOME.transient;
    // «An unknown error occurred» (1) sólo es pasajero cuando Meta lo acompaña
    // de un 5xx; con un 4xx es una petición mal formada.
    if (code === 1 && status >= 500) return OUTCOME.transient;
    // Cualquier otro código de Meta es una decisión de Meta que repetir no
    // cambia (calidad, política, plantilla, cuenta bloqueada…).
    return OUTCOME.permanent;
  }

  if (signal.noMessageId) return OUTCOME.ambiguous;

  // Un estado `failed` sin código no da evidencia para reenviar.
  if (signal.stage === "async") return OUTCOME.permanent;

  if (status === 0) {
    return network === "connect" ? OUTCOME.transient : OUTCOME.ambiguous;
  }
  if (status === 429) return OUTCOME.rate_limit;
  if (status === 503) return OUTCOME.transient;
  if (status >= 500) return OUTCOME.ambiguous;
  return OUTCOME.permanent;
}

/* ---------- Parámetros de reintento ---------- */

/** Intentos máximos por ciclo automático: 1 inicial + 2 reintentos. */
export const MAX_ATTEMPTS = 3;

/** Timeout HTTP de un intento a Meta. Vencido ⇒ ambiguo (`timeout`). */
export const ATTEMPT_TIMEOUT_MS = 30_000;

/** Arrendamiento del intento en vuelo; vencido ⇒ intento huérfano. */
export const LEASE_MS = 60_000;

/** Un `queued` que nadie reclamó en este tiempo (el proceso cayó antes del 1er intento). */
export const QUEUED_STALE_MS = 30_000;

const DEFAULT_BASE_MS = 5_000;
const DEFAULT_CAP_MS = 60_000;
const RATE_LIMIT_FACTOR = 6;
const RATE_LIMIT_CAP_FACTOR = 5;
const BACKOFF_GROWTH = 4;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Cada cuánto barre el trabajador (`OUTBOX_POLL_MS`, defecto 5 s). */
export function pollIntervalMs(): number {
  return envMs("OUTBOX_POLL_MS", 5_000);
}

/**
 * Espera antes del siguiente intento, con jitter.
 *
 * `failedAttempts` = cuántos intentos han fallado ya (1 tras el primer fallo).
 * Base exponencial: transitorio 5 s · 4^(n-1) (tope 60 s); límite de frecuencia
 * 6× más (30 s, 120 s; tope 300 s). «Equal jitter»: el resultado es uniforme en
 * [½·d, d], así los reintentos de muchos mensajes no se sincronizan.
 *
 * `OUTBOX_RETRY_BASE_MS` / `OUTBOX_RETRY_CAP_MS` cambian la escala (los tests
 * de integración corren el mismo algoritmo en milisegundos).
 */
export function retryDelayMs(
  cls: Extract<FailureClass, "transient" | "rate_limit">,
  failedAttempts: number,
  random: () => number = Math.random
): number {
  const base = envMs("OUTBOX_RETRY_BASE_MS", DEFAULT_BASE_MS);
  const cap = envMs("OUTBOX_RETRY_CAP_MS", DEFAULT_CAP_MS);
  const factor = cls === "rate_limit" ? RATE_LIMIT_FACTOR : 1;
  const capFactor = cls === "rate_limit" ? RATE_LIMIT_CAP_FACTOR : 1;
  const n = Math.max(1, failedAttempts);
  const ceiling = Math.min(cap * capFactor, base * factor * BACKOFF_GROWTH ** (n - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * r);
}

/** ¿Quedan intentos automáticos tras `attemptsMade` intentos? */
export function hasAttemptsLeft(attemptsMade: number): boolean {
  return attemptsMade < MAX_ATTEMPTS;
}
