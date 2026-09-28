import { extractTemporalQuery } from "@/server/agenda/query-intent";

/**
 * 026 — Memoria de aclaración de disponibilidad, PURA (sin BD, sin reloj
 * propio). Separada de `availability-query.ts` para poder probar la fusión de
 * contexto entre turnos sin el motor de disponibilidad.
 *
 * El servidor recuerda lo que YA entendió antes de que faltara una pieza
 * (spec 026 §3.3): nunca depende de que el modelo combine turnos por su
 * cuenta (regla 10). El turno actual manda si trae su propia información
 * explícita — el contexto sólo RELLENA lo que falta.
 */

export type WeekQualifier = "same" | "next";

/**
 * Lo mínimo que hace falta recordar entre turnos: SÓLO información semántica
 * de agenda ya entendida (calificador de semana, palabras de día), NUNCA el
 * mensaje completo del cliente ni ningún dato personal.
 */
export type AgendaClarifyContext = {
  /** Calificador de semana ya entendido (p. ej. "la próxima semana" sin día). */
  weekModifier?: WeekQualifier;
  /** Día(s) tal cual los dijo el cliente, ya entendidos, cuando falta el calificador. */
  days?: string[];
};

export type AgendaClarifyReason =
  | "unresolved_day"
  | "already_passed_this_week"
  | "too_many_days"
  | "unresolved_time"
  | "unresolved_range";

export type AgendaClarifyState = {
  count: number;
  kind: AgendaClarifyReason | null;
  context: AgendaClarifyContext | null;
};

export const EMPTY_CLARIFY_STATE: AgendaClarifyState = { count: 0, kind: null, context: null };

/** Tope de intentos consecutivos antes de escalar a un humano (regla 15). */
export const CLARIFY_ATTEMPTS_LIMIT = 3;

/** Tope de días recordados en el contexto (espejo del tope de `days[]`, 026 §3.2). */
const MAX_CONTEXT_DAYS = 3;
/** Tope de caracteres por palabra de día recordada — nunca una frase completa. */
const MAX_DAY_WORD_LENGTH = 40;
/** Tope del JSON persistido: sólo forma conocida, nunca texto libre (requisito del dueño). */
export const CLARIFY_CONTEXT_MAX_JSON_LENGTH = 300;

export type MinimalAvailabilityQuery = {
  day?: string;
  days?: string[];
  times?: string[];
  from?: string;
  to?: string;
  edge?: "earliest" | "latest";
};

// ---------------------------------------------------------------------------
// Saneo y (de)serialización — persistencia acotada en `conversation`
// ---------------------------------------------------------------------------

/** Sólo la forma conocida sobrevive: nunca texto libre, nunca datos personales. */
export function sanitizeClarifyContext(context: unknown): AgendaClarifyContext | null {
  if (!context || typeof context !== "object") return null;
  const c = context as Record<string, unknown>;
  const out: AgendaClarifyContext = {};
  if (c.weekModifier === "same" || c.weekModifier === "next") out.weekModifier = c.weekModifier;
  if (Array.isArray(c.days)) {
    const days = c.days
      .filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .slice(0, MAX_CONTEXT_DAYS)
      .map((d) => d.trim().slice(0, MAX_DAY_WORD_LENGTH));
    if (days.length > 0) out.days = days;
  }
  return out.weekModifier || out.days ? out : null;
}

/** `null` si no hay nada que guardar, o si el saneado no cupiera en el tope (nunca se guarda a medias). */
export function serializeClarifyContext(context: AgendaClarifyContext | null): string | null {
  const clean = sanitizeClarifyContext(context);
  if (!clean) return null;
  const json = JSON.stringify(clean);
  return json.length <= CLARIFY_CONTEXT_MAX_JSON_LENGTH ? json : null;
}

export function parseClarifyContext(raw: string | null | undefined): AgendaClarifyContext | null {
  if (!raw) return null;
  try {
    return sanitizeClarifyContext(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Respuestas cortas compatibles con una aclaración pendiente
// ---------------------------------------------------------------------------

const plain = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

/** «esta», «esta semana»: elige la semana ACTUAL en respuesta a «¿esta semana o la próxima?». */
const SAME_WEEK_CHOICE_RE = /^esta(\s+semana)?$/;
/** «la próxima», «próxima», «la próxima semana»: elige la semana SIGUIENTE. */
const NEXT_WEEK_CHOICE_RE = /^(la\s+)?proxima(\s+semana)?$/;

/** ¿Esta respuesta corta elige explícitamente una semana (la aclaración «¿esta semana o la próxima?»)? */
export function parseWeekChoiceReply(customerText: string): WeekQualifier | null {
  const t = plain(customerText);
  if (SAME_WEEK_CHOICE_RE.test(t)) return "same";
  if (NEXT_WEEK_CHOICE_RE.test(t)) return "next";
  return null;
}

/** Confirmaciones/deícticos cortos: no traen información nueva, pero SÍ se refieren a lo ya preguntado. */
const SHORT_CONFIRM_RE =
  /^(si|si\.|sí|ok|okay|dale|va|correcto|exacto|de una|perfecto|claro|esa|ese|esas|esos|la primera|la segunda|la anterior|la otra|no)$/;

/**
 * ¿Este mensaje sigue refiriéndose a la aclaración pendiente? Conserva el
 * contexto ante días, fechas, horas, rangos/expresiones temporales (vía
 * `extractTemporalQuery`, 025 rev.) y respuestas cortas compatibles («esa»,
 * «la próxima», «sí», «a las 4»). Un mensaje vacío es duda: se conserva.
 */
export function referencesPendingClarify(customerText: string): boolean {
  const t = customerText.trim();
  if (t === "") return true;
  if (extractTemporalQuery(t).hasTemporal) return true;
  const p = plain(t);
  if (SHORT_CONFIRM_RE.test(p)) return true;
  if (parseWeekChoiceReply(t) !== null) return true;
  return false;
}

/**
 * ¿Cambio INEQUÍVOCO de tema? Sólo cuando el mensaje NO se refiere a la
 * aclaración pendiente (arriba) Y trae contenido sustantivo. Determinista y
 * deliberadamente conservador ("si hay duda, conserva"): un falso positivo
 * sólo hace que se vuelva a preguntar de más, nunca que se invente nada. El
 * contexto NUNCA se limpia sólo porque el modelo haya elegido una acción no
 * relacionada con agenda — hace falta ADEMÁS esta señal determinista.
 */
export function isUnambiguousTopicChange(customerText: string): boolean {
  const t = customerText.trim();
  if (t === "") return false;
  if (referencesPendingClarify(t)) return false;
  return t.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
}

// ---------------------------------------------------------------------------
// Fusión con el turno actual (regla 10)
// ---------------------------------------------------------------------------

export type MergedQuery = {
  query: MinimalAvailabilityQuery;
  /** Calificador a aplicar a `query.day`/`query.days` SI ellos no traen uno propio (026 §3.1). */
  impliedWeekModifier?: WeekQualifier;
};

/**
 * Combina el contexto de una aclaración pendiente con lo que el cliente dijo
 * en ESTE turno. El turno actual manda: un día o calificador propio de este
 * turno nunca se pisa (`resolveDayExpression` ya protege esto: `impliedWeekModifier`
 * sólo aplica cuando la expresión de este turno no trae uno explícito).
 */
export function mergeClarifyContext(
  context: AgendaClarifyContext | null,
  query: MinimalAvailabilityQuery,
  customerText: string
): MergedQuery {
  if (!context) return { query };
  const merged: MinimalAvailabilityQuery = { ...query };
  const hasDay = Boolean(merged.day?.trim()) || (merged.days?.length ?? 0) > 0;
  const hasTimeOnly = (merged.times?.length ?? 0) > 0 || Boolean(merged.from?.trim() || merged.to?.trim());

  const inheritDays = () => {
    if (hasDay || !context.days || context.days.length === 0) return;
    if (context.days.length === 1) merged.day = context.days[0];
    else merged.days = [...context.days];
  };

  // «esta»/«la próxima» sueltos respondiendo a "¿esta semana o la próxima?":
  // resuelve el calificador y, si el día no vino en este turno, lo hereda.
  const chosenWeek = parseWeekChoiceReply(customerText);
  if (chosenWeek) {
    inheritDays();
    return { query: merged, impliedWeekModifier: chosenWeek };
  }

  // Sin día en este turno pero sí hora/rango («a las 4»): hereda día + calificador.
  if (!hasDay && hasTimeOnly) inheritDays();

  if (context.weekModifier) return { query: merged, impliedWeekModifier: context.weekModifier };
  return { query: merged };
}

// ---------------------------------------------------------------------------
// Transición de estado (contador, escalamiento — regla 15)
// ---------------------------------------------------------------------------

export type ClarifyOutcome =
  | { escalate: false; attempt: number; state: AgendaClarifyState }
  | { escalate: true; attempt: number; state: AgendaClarifyState };

/**
 * Cuántos intentos consecutivos llevaría ESTE turno si no resuelve — se
 * calcula ANTES de intentar resolver (no depende del resultado) para poder
 * pasarlo como `attempt` a `answerQuery` y que elija el texto correcto desde
 * la primera vez que hace falta variarlo.
 */
export function nextAttemptNumber(prev: AgendaClarifyState): number {
  return prev.count + 1;
}

/**
 * Un turno que NO resolvió: registra el intento y decide si toca escalar
 * (regla 15, ≥ `CLARIFY_ATTEMPTS_LIMIT`). `newContext` es lo que se pudo
 * entender de ESTE intento, para heredarlo en el siguiente si no escala.
 */
export function recordUnresolvedAttempt(
  prev: AgendaClarifyState,
  reason: AgendaClarifyReason,
  newContext: AgendaClarifyContext | null
): ClarifyOutcome {
  const attempt = nextAttemptNumber(prev);
  if (attempt >= CLARIFY_ATTEMPTS_LIMIT) {
    return { escalate: true, attempt, state: EMPTY_CLARIFY_STATE };
  }
  return {
    escalate: false,
    attempt,
    state: { count: attempt, kind: reason, context: sanitizeClarifyContext(newContext) },
  };
}
