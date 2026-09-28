import { normalizeQueryFields } from "@/server/agenda/query-intent";
import {
  addDaysISO,
  dayLabelInTz,
  eachDateInRange,
  hhmmTo12h,
  labelInTz,
  timeInTz,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  dayIsoInTz,
  type SlotUtc,
} from "@/lib/time/slots";
import {
  minutesOfDay,
  parseTimeReading,
  parseWeekQualifier,
  resolveDayExpression,
  weekdayDatesThisAndNextWeek,
  withinIntervals,
  type DayResolution,
  type WallInterval,
} from "@/lib/time/day-expressions";
import type {
  AgendaClarifyContext,
  AgendaClarifyReason,
  WeekQualifier,
} from "@/server/agenda/agenda-clarify-context";
import {
  buildCandidateSlots,
  computeAvailability,
  type AvailableSlot,
} from "@/server/agenda/availability";
import { nearestSlots } from "@/server/agenda/alternatives";
import type { OfferedSlot } from "@/server/agenda/offers";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";

/**
 * El prospecto lee "9:00 am", no "09:00" (el reloj de 24 h es del panel). Va
 * SOLO en los textos que se le envían: donde la hora se compara
 * (`minutesOfDay`) tiene que seguir siendo "HH:mm" o no parsea.
 */
const RELOJ_CLIENTE = { hour12: true } as const;

/**
 * 025 — CONSULTA DIRECTA de disponibilidad.
 *
 * Cuando el prospecto indica un día, una hora o un rango, la respuesta sale del
 * motor de disponibilidad (`computeAvailability`: horario, zona horaria,
 * duración, aviso mínimo, buffers y citas) evaluado sobre TODO el alcance
 * pedido, no de las primeras opciones que se le mostraron.
 *
 * Cada respuesta declara su completitud (`AvailabilityMeta`): una lista PARCIAL
 * (sugerencias) no se confunde nunca con la disponibilidad COMPLETA, y una
 * negación («no tengo…») sólo se emite cuando el alcance se evaluó completo y
 * de verdad no hay nada (`scopeComplete ∧ total = 0`).
 *
 * El texto lo arma el servidor; el modelo no redacta horarios.
 */

export type AvailabilityQuery = {
  /** Lo que dijo el prospecto o ISO: "mañana", "lunes", "25 de septiembre", "2026-09-21". */
  day?: string;
  /**
   * 026 — Días ALTERNATIVOS ("jueves o viernes"), en el orden en que el
   * cliente los dijo, tope `MAX_QUERY_DAYS`. Mutuamente excluyente con `day`:
   * si vienen ambos, `days` gana (ver `normalizeQueryFields`).
   */
  days?: string[];
  /** Horas concretas: "11", "12:00", "4 de la tarde". */
  times?: string[];
  /** Rango: el horario debe iniciar ≥ `from` y terminar ≤ `to`. */
  from?: string;
  to?: string;
  edge?: "earliest" | "latest";
};

export type AvailabilityKind =
  | "suggestions"
  | "day"
  /** 026 — dos o tres días alternativos pedidos por nombre (`days[]`). */
  | "days"
  | "times"
  | "range"
  | "edge"
  | "overview"
  | "clarify"
  | "none";

/** 026 — tope de días alternativos que se evalúan en una sola consulta. */
export const MAX_QUERY_DAYS = 3;

export type AvailabilityMeta = {
  kind: AvailabilityKind;
  /** El alcance (día u horizonte) se evaluó COMPLETO: única base para decir «no hay». */
  scopeComplete: boolean;
  /** La lista transmitida contiene TODOS los horarios que cumplen (= scopeComplete ∧ ¬hasMore). */
  exhaustive: boolean;
  /** Hay horarios que cumplen la consulta y no se transmitieron/registraron. */
  hasMore: boolean;
  /** Cuántos cumplen la consulta (completo, no truncado). */
  total: number;
  /** Cuántos se transmitieron en el texto. */
  conveyed: number;
};

/** Una hora pedida y su veredicto contra el motor (para pruebas y trazabilidad). */
export type TimeCheck = {
  dayIso: string;
  hhmm: string;
  free: boolean;
  reason?: NotFreeReason;
};

export type AvailabilityAnswer = {
  text: string;
  /** Horarios a persistir CON el mensaje (`pending`): todo el alcance, `shown` = lo que el texto enseña. */
  offers: OfferedSlot[];
  meta: AvailabilityMeta;
  /** Los horarios que cumplen la consulta (completo; el texto puede resumirlos). */
  matches: AvailableSlot[];
  /** true ⇒ hay al menos un horario que cumple la consulta. */
  ok: boolean;
  status: "availability" | "availability_clarify";
  checks: TimeCheck[];
  /**
   * 026 — presente SÓLO cuando `status === "availability_clarify"`: por qué
   * no se pudo resolver y qué se entendió (para heredarlo en el turno
   * siguiente, `agenda-clarify-context.ts`). `null`/ausente si no hay nada
   * que recordar.
   */
  clarify?: { reason: AgendaClarifyReason; context: AgendaClarifyContext | null };
};

export type NotFreeReason =
  | "closed_day"
  | "out_of_hours"
  | "off_grid"
  | "past"
  | "too_soon"
  | "occupied";

/** Tope de horarios que se registran por consulta (un día de 10 min por 09-18 son 54). */
export const MAX_REGISTERED = 60;
/** Días que se describen cuando el alcance es todo el horizonte. */
export const MAX_DAYS_SHOWN = 3;
/** Alternativas cercanas que se sugieren cuando lo pedido no está libre. */
const NEAREST = 3;

export type DayData = {
  dayIso: string;
  /** TODOS los inicios libres de ese día (completo). */
  free: AvailableSlot[];
  /** Inicios que el horario semanal genera ese día (sin quitar ocupados ni aviso). */
  candidates: SlotUtc[];
  intervals: WallInterval[];
};

/* ------------------------------------------------------------------ */
/* Wrapper con acceso a datos                                          */
/* ------------------------------------------------------------------ */

export async function queryAvailability(input: {
  organizationId: string;
  query: AvailabilityQuery;
  now?: Date;
  settings?: CalendarSettings;
  /** 026 — calificador de semana heredado de una aclaración pendiente (regla 10). */
  impliedWeekModifier?: WeekQualifier;
  /** 026 — 1 = primera vez que se pregunta esto; ≥2 = ya se preguntó antes (varía el texto). */
  priorClarifyAttempt?: number;
}): Promise<AvailabilityAnswer> {
  const settings = input.settings ?? (await getSettings(input.organizationId));
  const now = input.now ?? new Date();
  const tz = settings.timezone;
  const todayIso = todayInTz(now, tz);
  const horizonEndIso = addDaysISO(todayIso, settings.maxDaysAhead);

  // UNA sola consulta al motor: el horizonte completo. De ahí salen la respuesta
  // del día pedido, las sugerencias cercanas y la verdad para no inventar nada.
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
    fromISO: todayIso,
    toISO: horizonEndIso,
  });
  const byDay = new Map<string, AvailableSlot[]>();
  for (const slot of all) {
    const d = dayIsoInTz(new Date(slot.startUtc), tz);
    const bucket = byDay.get(d);
    if (bucket) bucket.push(slot);
    else byDay.set(d, [slot]);
  }
  const days: DayData[] = eachDateInRange(todayIso, horizonEndIso).map((dayIso) => {
    const key = weekdayKeyOf(dayIso, tz);
    return {
      dayIso,
      free: byDay.get(dayIso) ?? [],
      candidates: buildCandidateSlots(settings, dayIso, dayIso),
      intervals: (key ? settings.weeklyHours[key] : undefined) ?? [],
    };
  });

  return answerQuery({
    query: input.query,
    settings,
    now,
    todayIso,
    horizonEndIso,
    days,
    impliedWeekModifier: input.impliedWeekModifier,
    priorClarifyAttempt: input.priorClarifyAttempt,
  });
}

/* ------------------------------------------------------------------ */
/* Núcleo PURO                                                         */
/* ------------------------------------------------------------------ */

export function answerQuery(input: {
  query: AvailabilityQuery;
  settings: CalendarSettings;
  now: Date;
  todayIso: string;
  horizonEndIso: string;
  /** Todos los días del horizonte [hoy, hoy + maxDaysAhead], completos. */
  days: DayData[];
  /** 026 — calificador de semana heredado de una aclaración pendiente (regla 10). */
  impliedWeekModifier?: WeekQualifier;
  /** 026 — 1 = primera vez que se pregunta esto; ≥2 = ya se preguntó antes (varía el texto, regla 14). */
  priorClarifyAttempt?: number;
}): AvailabilityAnswer {
  const { settings, now, todayIso, horizonEndIso, days } = input;
  // `""`, espacios y `[]` son AUSENCIA (defensa en profundidad: quien llame, el modelo o la API).
  const query: AvailabilityQuery = normalizeQueryFields(input.query as Record<string, unknown>);
  const tz = settings.timezone;
  const ctx: Ctx = { settings, now, tz, days };
  const attempt = input.priorClarifyAttempt ?? 1;

  const wantsTimes = (query.times?.length ?? 0) > 0;
  const wantsRange = Boolean(query.from || query.to);

  // 1) Alcance: uno o varios días concretos (026: `days[]`), o todo el horizonte.
  const dayTokens: string[] | null =
    query.days && query.days.length > 0
      ? query.days
      : query.day && query.day.trim() !== ""
        ? [query.day]
        : null;

  let scope: DayData[] = days;
  let namedCount = 0;
  /** 026 — notas honestas de días NOMBRADOS que cayeron fuera de alcance (pasado/horizonte, regla 13). */
  const outOfScopeNotes: string[] = [];

  if (dayTokens) {
    if (dayTokens.length > MAX_QUERY_DAYS) {
      return clarifyWith(
        attempt <= 1
          ? `Puedo revisar hasta ${MAX_QUERY_DAYS} días a la vez — ¿cuáles de esos te interesan más?`
          : `Dime hasta ${MAX_QUERY_DAYS} días (por ejemplo «jueves y viernes») y los reviso.`,
        "too_many_days",
        null
      );
    }
    const resolutions = dayTokens.map((token) => ({
      token,
      result: resolveDayExpression(token, todayIso, input.impliedWeekModifier),
    }));
    const failed = resolutions.filter(
      (r): r is { token: string; result: Extract<DayResolution, { ok: false }> } => !r.result.ok
    );
    if (failed.length > 0) {
      return buildDayClarify(failed, ctx, todayIso, attempt);
    }
    const resolvedIsos: { token: string; dayIso: string }[] = resolutions.map((r) => ({
      token: r.token,
      dayIso: (r.result as Extract<DayResolution, { ok: true }>).dayIso,
    }));
    namedCount = dayTokens.length;
    if (namedCount === 1) {
      // Sin cambio de 025: un solo día pasado/fuera de horizonte aborta con una respuesta honesta.
      const { dayIso } = resolvedIsos[0]!;
      if (dayIso < todayIso) {
        return none(`Esa fecha (${dayName(dayIso, ctx)}) ya pasó. ¿Qué otro día te acomoda?`);
      }
      if (dayIso > horizonEndIso) {
        return none(
          `Por ahora agendo hasta el ${dayName(horizonEndIso, ctx)}. ¿Te acomoda algún día antes de esa fecha?`
        );
      }
    } else {
      // 026 regla 13: cada día nombrado se explica por separado, sin abortar el resto.
      for (const { dayIso } of resolvedIsos) {
        if (dayIso < todayIso) {
          outOfScopeNotes.push(`${cap(dayName(dayIso, ctx))} ya pasó.`);
        } else if (dayIso > horizonEndIso) {
          outOfScopeNotes.push(
            `${cap(dayName(dayIso, ctx))} está fuera de mi horizonte (agendo hasta el ${dayName(horizonEndIso, ctx)}).`
          );
        }
      }
    }
    // 026 regla: conserva el ORDEN del cliente (no el cronológico) — «jueves o
    // viernes» describe primero el jueves aunque su fecha caiga después.
    // Dedupe por si dos tokens resuelven al MISMO día (p. ej. "este jueves" y
    // "jueves que viene" coincidiendo): se describe una sola vez.
    scope = [];
    const seenIsos = new Set<string>();
    for (const { dayIso } of resolvedIsos) {
      if (dayIso < todayIso || dayIso > horizonEndIso) continue;
      if (seenIsos.has(dayIso)) continue;
      seenIsos.add(dayIso);
      const found = days.find((d) => d.dayIso === dayIso);
      if (found) scope.push(found);
    }
    if (namedCount >= 2 && scope.length === 0) {
      return none(outOfScopeNotes.join(" "));
    }
  }
  const singleDay = namedCount === 1;
  const multiDay = namedCount >= 2;

  // 2) Rango (si lo pidió): se lee una vez por día porque el horario cambia.
  const rangeFor = (d: DayData): { from: number; to: number } | "unparsable" => {
    let from = 0;
    let to = 24 * 60;
    if (query.from) {
      const r = parseTimeReading(query.from, d.intervals);
      if (!r) return "unparsable";
      from = minutesOfDay(r.candidates[0]!);
    }
    if (query.to) {
      const r = parseTimeReading(query.to, d.intervals);
      if (!r) return "unparsable";
      to = minutesOfDay(r.candidates[0]!);
    }
    return { from, to };
  };

  // 3) Evaluación por día.
  const results: DayResult[] = [];
  const checks: TimeCheck[] = [];
  for (const d of scope) {
    if (wantsTimes) {
      const asked = askedTimes(query.times!, d, ctx);
      if (asked === "unparsable") {
        return clarifyWith(
          attempt <= 1
            ? "¿A qué hora quieres que lo revise? Dime, por ejemplo, «a las 11», «a las 4 de la tarde» o «a las 16:00»."
            : "Dime la hora así: «11», «4 de la tarde» o «16:00».",
          "unresolved_time",
          null
        );
      }
      for (const a of asked) checks.push({ dayIso: d.dayIso, hhmm: a.hhmm, free: a.free, reason: a.reason });
      results.push({ day: d, matches: asked.filter((a) => a.free).map((a) => a.slot!), asked });
      continue;
    }
    let base = d.free;
    if (wantsRange) {
      const r = rangeFor(d);
      if (r === "unparsable") {
        return clarifyWith(
          attempt <= 1
            ? "¿Entre qué horas quieres que lo revise? Por ejemplo, «entre las 2 y las 4 de la tarde»."
            : "Dime el rango así: «entre las 2 y las 4 de la tarde» o «después de las 3».",
          "unresolved_range",
          null
        );
      }
      base = d.free.filter(
        (s) =>
          minutesOfDay(timeInTz(s.startUtc, tz)) >= r.from &&
          endMinutes(s, tz) <= r.to
      );
    }
    if (query.edge && base.length > 0) {
      const pick = query.edge === "latest" ? base[base.length - 1]! : base[0]!;
      results.push({ day: d, matches: [pick], edgeOf: base });
    } else {
      results.push({ day: d, matches: base });
    }
  }

  const kind: AvailabilityKind = wantsTimes
    ? "times"
    : query.edge
      ? "edge"
      : wantsRange
        ? "range"
        : multiDay
          ? "days"
          : singleDay
            ? "day"
            : "overview";

  // 4) Qué días se describen.
  const withMatches = results.filter((r) => r.matches.length > 0);
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  const presented = singleDay || multiDay ? results : withMatches.slice(0, MAX_DAYS_SHOWN);
  const omittedDays = singleDay || multiDay ? 0 : Math.max(0, withMatches.length - presented.length);

  // 5) Texto + horarios.
  const lines: string[] = [];
  const shownStarts = new Set<string>();
  const registerDays: DayData[] = [];
  let conveyed = 0;
  let cappedDay = false;
  // 026: con varios días nombrados, cada uno se explica aunque no tenga nada (regla 13) —
  // salvo "edge" (`describeDay` no sabe describir un extremo vacío; combinación rara, sin evidencia real).
  const alwaysIncludeDay = kind === "times" || (multiDay && kind !== "edge");

  for (const r of presented) {
    // Una pregunta por horas (o varios días nombrados) siempre se responde;
    // los demás tipos sólo describen días que tienen algo que cumpla.
    if (r.matches.length === 0 && !alwaysIncludeDay) continue;
    const { line, shown, capped } = describeDay(kind, r, ctx, query);
    lines.push(line);
    for (const s of shown) shownStarts.add(s.startUtc);
    conveyed += kind === "times" ? r.matches.length : Math.min(shown.length, r.matches.length);
    if (capped) cappedDay = true;
    if (r.day.free.length > 0) registerDays.push(r.day);
  }

  // 6) Sin nada que cumpla: negación honesta (alcance completo) + cercanas.
  let extraSuggestions: AvailableSlot[] = [];
  if (total === 0) {
    const horizonFree = days.flatMap((d) => d.free);
    if (multiDay) {
      // El bucle de arriba ya explicó cada día por separado (regla 13, describeDay→dayEmptyText);
      // aquí sólo se agregan las opciones más cercanas.
      const anchorDay = scope[0];
      const anchor = anchorDay
        ? anchorUtc(anchorDay.dayIso, query, anchorDay.intervals, tz)
        : anchorUtc(todayIso, query, [], tz);
      extraSuggestions = nearestSlots(horizonFree, anchor, tz, NEAREST);
    } else if (singleDay) {
      const target = scope[0]!;
      if (kind !== "times") {
        lines.length = 0;
        lines.push(dayEmptyText(target, kind, ctx, query));
        // Un rango sin coincidencias sí describe el día completo: se registra y se muestra.
        if ((kind === "range" || Boolean(query.from || query.to)) && target.free.length > 0) {
          for (const s of target.free.slice(0, MAX_REGISTERED)) shownStarts.add(s.startUtc);
          if (!registerDays.includes(target)) registerDays.push(target);
        }
      }
      // Sólo si el día no ofrece nada que enseñar se sugiere lo más cercano.
      if (target.free.length === 0) {
        const anchor = anchorUtc(target.dayIso, query, target.intervals, tz);
        extraSuggestions = nearestSlots(horizonFree, anchor, tz, NEAREST);
      }
    } else {
      lines.length = 0;
      lines.push(horizonEmptyText(kind, ctx, query, settings.maxDaysAhead));
      extraSuggestions = horizonFree.slice(0, NEAREST);
    }
    if (extraSuggestions.length > 0) {
      lines.push(
        "Lo más cercano que tengo:\n" + extraSuggestions.map((s) => `• ${s.label}`).join("\n")
      );
      for (const s of extraSuggestions) shownStarts.add(s.startUtc);
    }
  } else if (omittedDays > 0) {
    lines.push("Tengo más días con horarios disponibles; dime cuál te acomoda.");
  }
  // 026 regla 13: días NOMBRADOS que quedaron fuera de alcance, explicados aparte (nunca negados).
  if (multiDay && outOfScopeNotes.length > 0) lines.push(...outOfScopeNotes);

  // 7) Registro: todo el alcance descrito (tope), `shown` = lo que el texto enseña.
  const catalog = new Map<string, OfferedSlot>();
  for (const d of registerDays) {
    for (const s of d.free) {
      if (catalog.size >= MAX_REGISTERED) break;
      catalog.set(s.startUtc, { startUtc: s.startUtc, label: s.label, shown: shownStarts.has(s.startUtc) });
    }
  }
  for (const s of extraSuggestions) {
    if (!catalog.has(s.startUtc) && catalog.size < MAX_REGISTERED) {
      catalog.set(s.startUtc, { startUtc: s.startUtc, label: s.label, shown: true });
    }
  }

  const hasMore = omittedDays > 0 || cappedDay;
  const meta: AvailabilityMeta = {
    kind,
    scopeComplete: true,
    exhaustive: !hasMore,
    hasMore,
    total,
    conveyed,
  };
  return {
    text: lines.join("\n"),
    offers: [...catalog.values()],
    meta,
    matches: results.flatMap((r) => r.matches),
    ok: total > 0,
    status: "availability",
    checks,
  };
}

/* ------------------------------------------------------------------ */
/* Piezas                                                              */
/* ------------------------------------------------------------------ */

type Ctx = { settings: CalendarSettings; now: Date; tz: string; days: DayData[] };

type Asked = {
  hhmm: string;
  free: boolean;
  slot: AvailableSlot | null;
  reason?: NotFreeReason;
};

type DayResult = {
  day: DayData;
  matches: AvailableSlot[];
  asked?: Asked[];
  /** Para `edge`: el conjunto entre el que se eligió el extremo. */
  edgeOf?: AvailableSlot[];
};

/**
 * 026 — Una aclaración, con la RAZÓN (para variar el texto y decidir el
 * escalamiento, `agenda-clarify-context.ts`) y lo que ya se entendió (para
 * heredarlo en el turno siguiente, regla 10). `context` es `null` cuando no
 * hay nada que recordar.
 */
function clarifyWith(
  text: string,
  reason: AgendaClarifyReason,
  context: AgendaClarifyContext | null
): AvailabilityAnswer {
  return {
    text,
    offers: [],
    meta: { kind: "clarify", scopeComplete: false, exhaustive: false, hasMore: false, total: 0, conveyed: 0 },
    matches: [],
    ok: false,
    status: "availability_clarify",
    checks: [],
    clarify: { reason, context },
  };
}

/**
 * 026 — Uno o varios días de `days[]`/`day` que NO se pudieron resolver
 * (`resolveDayExpression` devolvió `ok:false`). Cuando TODOS fallan por la
 * misma razón "ya pasó esta semana" (ambigüedad COMPARTIDA de semana), se usa
 * la pregunta corta de la regla del dueño: «¿esta semana o la próxima?» —
 * nunca una enumeración cartesiana de fechas por cada día.
 */
function buildDayClarify(
  failed: { token: string; result: Extract<DayResolution, { ok: false }> }[],
  ctx: Ctx,
  todayIso: string,
  attempt: number
): AvailabilityAnswer {
  const allPassedThisWeek = failed.every((f) => f.result.reason === "already_passed_this_week");
  if (allPassedThisWeek) {
    const passedNames = failed
      .map((f) => weekdayDatesThisAndNextWeek(f.token, todayIso))
      .filter((d): d is { same: string; next: string } => d !== null)
      .map((d) => dayName(d.same, ctx));
    const label =
      passedNames.length === 0
        ? "Ese día"
        : passedNames.length === 1
          ? cap(passedNames[0]!)
          : `${cap(passedNames[0]!)} y ${passedNames[1]!}`;
    const verb = failed.length > 1 ? "ya pasaron" : "ya pasó";
    const text =
      attempt <= 1
        ? `${label} de esta semana ${verb}. ¿Te refieres a la próxima semana o prefieres otro día?`
        : "¿Esta semana o la próxima?";
    return clarifyWith(text, "already_passed_this_week", { days: failed.map((f) => f.token) });
  }

  // Genérico: una o varias expresiones sin reconocer (o mezcladas con otra razón).
  const detectedQualifier = failed
    .map((f) => parseWeekQualifier(f.token).qualifier)
    .find((q): q is WeekQualifier => q !== "none");
  const context: AgendaClarifyContext | null = detectedQualifier ? { weekModifier: detectedQualifier } : null;
  const text =
    attempt <= 1
      ? failed.length > 1
        ? "¿Para qué días quieres que lo revise? Dime, por ejemplo, «jueves y viernes» o una fecha como «25 de septiembre»."
        : "¿Para qué día quieres que lo revise? Dime, por ejemplo, «mañana», «el lunes» o una fecha como «25 de septiembre»."
      : `Cuéntame el día así: «jueves», «el 25 de septiembre» o «mañana» (mañana sería ${dayName(addDaysISO(todayIso, 1), ctx)}).`;
  return clarifyWith(text, "unresolved_day", context);
}

/** Una respuesta que NO afirma disponibilidad (fecha pasada o fuera de horizonte). */
function none(text: string): AvailabilityAnswer {
  return {
    text,
    offers: [],
    meta: { kind: "none", scopeComplete: false, exhaustive: false, hasMore: false, total: 0, conveyed: 0 },
    matches: [],
    ok: false,
    status: "availability",
    checks: [],
  };
}

function endMinutes(s: AvailableSlot, tz: string): number {
  const m = minutesOfDay(timeInTz(s.endUtc, tz));
  return m === 0 ? 24 * 60 : m;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "mañana viernes, 18 de septiembre" (siempre con la fecha completa). */
function dayName(dayIso: string, ctx: Ctx): string {
  const noon = zonedWallClockToUtc(dayIso, "12:00", ctx.tz);
  return noon ? dayLabelInTz(noon.toISOString(), ctx.tz, ctx.now) : dayIso;
}

function askedTimes(tokens: string[], d: DayData, ctx: Ctx): Asked[] | "unparsable" {
  const out: Asked[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const reading = parseTimeReading(token, d.intervals);
    if (!reading) return "unparsable";
    for (const hhmm of reading.candidates) {
      if (seen.has(hhmm)) continue;
      seen.add(hhmm);
      out.push(evaluateTime(d, hhmm, ctx));
    }
  }
  return out;
}

function evaluateTime(d: DayData, hhmm: string, ctx: Ctx): Asked {
  const start = zonedWallClockToUtc(d.dayIso, hhmm, ctx.tz);
  const iso = start ? start.toISOString() : "";
  const slot = d.free.find((s) => s.startUtc === iso) ?? null;
  if (slot) return { hhmm, free: true, slot };

  if (d.intervals.length === 0) return { hhmm, free: false, slot: null, reason: "closed_day" };
  const candidate = d.candidates.find((c) => c.startUtc === iso);
  if (candidate) {
    const startMs = Date.parse(candidate.startUtc);
    if (startMs < ctx.now.getTime()) return { hhmm, free: false, slot: null, reason: "past" };
    if (startMs < ctx.now.getTime() + ctx.settings.minNoticeHours * 3_600_000) {
      return { hhmm, free: false, slot: null, reason: "too_soon" };
    }
    return { hhmm, free: false, slot: null, reason: "occupied" };
  }
  // No es un inicio del horario: ¿cae dentro del horario (rejilla) o fuera?
  const inside = withinIntervals(hhmm, d.intervals);
  return { hhmm, free: false, slot: null, reason: inside ? "off_grid" : "out_of_hours" };
}

function hoursSummary(intervals: WallInterval[]): string {
  // Horas de pared que lee el prospecto: mismo reloj que el resto del mensaje.
  return intervals
    .map((iv) => `${hhmmTo12h(iv.start)} a ${hhmmTo12h(iv.end)}`)
    .join(" y ");
}

function reasonClause(a: Asked, d: DayData, ctx: Ctx): string {
  switch (a.reason) {
    case "closed_day":
      return "ese día no atiendo";
    case "out_of_hours":
      return `queda fuera de mi horario (${hoursSummary(d.intervals)})`;
    case "off_grid": {
      const step = ctx.settings.slotMinutes + Math.max(0, ctx.settings.bufferMinutes);
      const t = minutesOfDay(a.hhmm);
      // Se ORDENA en 24 h (minutesOfDay no sabe leer "9:00 am") y se
      // PRESENTA en el reloj del cliente. Mezclar las dos cosas daba NaN.
      const near = d.candidates
        .map((c) => timeInTz(c.startUtc, ctx.tz))
        .sort((x, y) => Math.abs(minutesOfDay(x) - t) - Math.abs(minutesOfDay(y) - t))
        .slice(0, 2)
        .sort()
        .map(hhmmTo12h);
      return `no coincide con mis horarios de inicio (cada ${step} min${near.length ? `: ${near.join(" o ")}` : ""})`;
    }
    case "past":
      return "ya pasó";
    case "too_soon":
      return `no alcanzo a agendarlo (aviso mínimo de ${ctx.settings.minNoticeHours} h)`;
    case "occupied":
      return "ya está ocupado";
    default:
      return "no está disponible";
  }
}

/** "09:00 a 12:30 y 14:00 a 17:30 (cada 30 min)" o "10:00, 11:30 y 15:00". */
export function describeStarts(slots: AvailableSlot[], ctx: { settings: CalendarSettings; tz: string }): string {
  if (slots.length === 0) return "";
  const step = (ctx.settings.slotMinutes + Math.max(0, ctx.settings.bufferMinutes)) * 60_000;
  const groups: AvailableSlot[][] = [];
  for (const s of slots) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && Date.parse(s.startUtc) - Date.parse(prev.startUtc) === step) last.push(s);
    else groups.push([s]);
  }
  let usedRange = false;
  const parts = groups.flatMap((g) => {
    if (g.length >= 3) {
      usedRange = true;
      return [`de ${timeInTz(g[0]!.startUtc, ctx.tz, RELOJ_CLIENTE)} a ${timeInTz(g[g.length - 1]!.startUtc, ctx.tz, RELOJ_CLIENTE)}`];
    }
    return g.map((s) => timeInTz(s.startUtc, ctx.tz, RELOJ_CLIENTE));
  });
  const joined =
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
  return usedRange ? `${joined} (cada ${step / 60_000} min)` : joined;
}

function describeDay(
  kind: AvailabilityKind,
  r: DayResult,
  ctx: Ctx,
  query: AvailabilityQuery
): { line: string; shown: AvailableSlot[]; capped: boolean } {
  const name = cap(dayName(r.day.dayIso, ctx));
  const dur = `Cada sesión dura ${ctx.settings.slotMinutes} min.`;

  if (kind === "times" && r.asked) {
    const clauses = r.asked.map((a) =>
      a.free
        ? `a las ${hhmmTo12h(a.hhmm)} sí tengo`
        : `a las ${hhmmTo12h(a.hhmm)} ${reasonClause(a, r.day, ctx)}`
    );
    const allFree = r.asked.every((a) => a.free);
    let line: string;
    if (allFree) {
      const times = r.asked.map((a) => hhmmTo12h(a.hhmm));
      line = `${name} sí tengo libre a las ${times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} y ${times[times.length - 1]}`}.`;
    } else {
      line = `${name}: ${clauses.join("; ")}.`;
    }
    const shown = r.matches.slice();
    // Si algo no está libre y el día tiene otros, se completa con TODO lo del día.
    if (!allFree && r.day.free.length > 0) {
      line += ` Ese día también puedo iniciar ${describeStarts(r.day.free.slice(0, MAX_REGISTERED), ctx)}.`;
      shown.push(...r.day.free.slice(0, MAX_REGISTERED));
      return { line, shown, capped: r.day.free.length > MAX_REGISTERED };
    }
    return { line, shown, capped: false };
  }

  if (kind === "edge") {
    const which = query.edge === "latest" ? "más tarde" : "más temprano";
    const s = r.matches[0]!;
    return {
      line: `${name}, el horario ${which} para iniciar es a las ${timeInTz(s.startUtc, ctx.tz, RELOJ_CLIENTE)}.`,
      shown: [s],
      capped: false,
    };
  }

  // day | days | range | overview — 026: un día nombrado (`multiDay`) sin nada que cumpla
  // se explica con su causa real, nunca con una lista vacía ("puedo iniciar .").
  if (r.matches.length === 0) {
    return { line: dayEmptyText(r.day, kind, ctx, query), shown: [], capped: false };
  }
  const list = r.matches.slice(0, MAX_REGISTERED);
  const capped = r.matches.length > MAX_REGISTERED;
  const lead = kind === "range" ? `${name} entre esas horas puedo iniciar` : `${name} puedo iniciar`;
  let line = `${lead} ${describeStarts(list, ctx)}. ${dur}`;
  if (capped) line += " Tengo más horarios ese día; dime una hora y la reviso.";
  return { line, shown: list, capped };
}

/** Día sin nada para la consulta: explica POR QUÉ con la evaluación completa del día. */
function dayEmptyText(d: DayData, kind: AvailabilityKind, ctx: Ctx, query: AvailabilityQuery): string {
  const name = cap(dayName(d.dayIso, ctx));
  if (d.intervals.length === 0) return `${name} no atiendo.`;
  if (d.candidates.length === 0) return `${name} no tengo horarios de atención.`;
  if (d.free.length === 0) {
    const allSoon = d.candidates.every(
      (c) => Date.parse(c.startUtc) < ctx.now.getTime() + ctx.settings.minNoticeHours * 3_600_000
    );
    return allSoon
      ? `${name} ya no alcanzo a agendar (aviso mínimo de ${ctx.settings.minNoticeHours} h).`
      : `${name} ya no me quedan horarios libres.`;
  }
  // El día tiene horarios, pero ninguno cumple el rango/extremo pedido.
  if (kind === "range" || query.from || query.to) {
    return `${name} no tengo horarios dentro de ese rango. Ese día sí puedo iniciar ${describeStarts(d.free.slice(0, MAX_REGISTERED), ctx)}.`;
  }
  return `${name} ya no me quedan horarios libres.`;
}

function horizonEmptyText(kind: AvailabilityKind, ctx: Ctx, query: AvailabilityQuery, horizonDays: number): string {
  const span = `en los próximos ${horizonDays} días`;
  if (kind === "times") return `No tengo libre a esa hora ${span}.`;
  if (kind === "range") return `No tengo horarios dentro de ese rango ${span}.`;
  void query;
  void ctx;
  return `No me quedan horarios libres ${span}.`;
}

/** Hora ancla para «lo más cercano»: la pedida, si la hay; si no, media mañana. */
function anchorUtc(dayIso: string, query: AvailabilityQuery, intervals: WallInterval[], tz: string): string {
  let hhmm = "12:00";
  const token = query.times?.[0] ?? query.from;
  if (token) {
    const r = parseTimeReading(token, intervals);
    if (r) hhmm = r.candidates[0]!;
  }
  return (zonedWallClockToUtc(dayIso, hhmm, tz) ?? new Date()).toISOString();
}

/* ------------------------------------------------------------------ */
/* Guard de una negación escrita a mano por el modelo                   */
/* ------------------------------------------------------------------ */

/** Negaciones que hablan de HORARIOS/agenda sin ambigüedad. */
const SCHEDULE_NEGATIONS: RegExp[] = [
  /\bno (me )?(quedan|queda|tengo|tenemos|hay|contamos con|cuento con)\b[^.\n]{0,25}\b(horarios?|espacios?|lugares?|huecos?|citas?)\b/i,
  /\b(sin|ya no hay|no hay) (m[aá]s )?horarios?\b/i,
  /\bagenda (est[aá] )?(llena|completa|saturada|ocupada)\b/i,
];

/** «No hay disponibilidad» sólo cuenta si el texto habla de agenda/horas/días. */
const NO_AVAILABILITY =
  /\b(no (hay|tengo|tenemos|cuento con|contamos con)|sin|ya no hay)\b[^.\n]{0,20}\bdisponibilidad\b/i;
const SCHEDULE_CONTEXT =
  /\b(horarios?|agenda|citas?|d[ií]as?|horas?|semana|ma[nñ]ana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|llamada|reuni[oó]n)\b/i;

/**
 * ¿El texto afirma que NO hay agenda/horarios? Sirve al guard del pipeline: una
 * negación escrita por el modelo (que sólo vio una lista truncada) no se envía;
 * se sustituye por una consulta real. Deliberadamente estrecho: «no tengo
 * disponibilidad de stock» NO cuenta (no habla de agenda).
 */
export function claimsNoAvailability(text: string): boolean {
  if (SCHEDULE_NEGATIONS.some((re) => re.test(text))) return true;
  return NO_AVAILABILITY.test(text) && SCHEDULE_CONTEXT.test(text);
}

/* Re-export para el cerebro externo y los tests. */
export { labelInTz };
