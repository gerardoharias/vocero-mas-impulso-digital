import { addDaysISO } from "@/lib/time/slots";

/**
 * 025 — Interpretación DETERMINISTA de lo que el prospecto dijo: un día
 * («mañana», «lunes», «25 de septiembre») y una hora («11», «4 de la tarde»).
 *
 * El modelo pasa las palabras del prospecto tal cual; esto las resuelve. Es puro
 * (sin BD ni reloj implícito) para poder probarlo entero: la aritmética de
 * fechas y zonas horarias es justo lo que un LLM hace mal.
 */

/** 026 — por qué no se pudo resolver un día (además del caso genérico). */
export type DayFailureReason = "already_passed_this_week";

export type DayResolution =
  | { ok: true; dayIso: string }
  | { ok: false; reason?: DayFailureReason };

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTH_INDEX: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  sept: 9,
  set: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

/** Minúsculas, sin acentos, sin puntuación de relleno ni artículos. */
export function normalizeExpression(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!,;]/g, " ")
    .replace(/\b(el|la|este|esta|proximo|proxima|para|del|dia)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 026 — Calificador de semana pegado a un día de semana, SEPARADO del resto
 * antes de normalizar (si no, «este»/«esta» se pierden como relleno genérico
 * y «de la próxima semana» nunca hace match con nada).
 *
 * - `"next"`  → «de la próxima semana», «de la semana que viene/entrante»,
 *   «de la otra semana»: SIEMPRE la semana calendario siguiente (regla 4).
 * - `"same"`  → «este»/«esta»: la semana calendario ACTUAL, puede ser hoy
 *   (regla 5).
 * - `"none"`  → sin calificador, o «el próximo»/«que viene» sueltos (sin la
 *   palabra "semana"): la ocurrencia más cercana, SIN CAMBIO (reglas 1-3, 6).
 *   («próximo»/«que viene» ya equivalen a "bare" — no acarrean estado propio).
 */
export type WeekQualifier = "none" | "same" | "next";

/**
 * «de la» es OPCIONAL a propósito: cubre tanto «jueves DE LA próxima semana»
 * (pegado a un día) como una frase SUELTA («la semana que viene», sin día —
 * evidencia real del dueño, mensaje 1) para que `parseWeekQualifier` la
 * reconozca igual y el llamador (`buildDayClarify`) pueda recordar el
 * calificador aunque no haya ningún día que resolver todavía.
 */
const NEXT_WEEK_QUALIFIER_RE =
  /\b(?:de\s+)?(?:la\s+)?(?:proxima\s+semana|otra\s+semana|semana\s+(?:que\s+viene|proxima|entrante))\b/;
const SAME_WEEK_QUALIFIER_RE = /\b(?:este|esta)\s+/;
/** «jueves que viene» (SIN "semana"): equivale a bare, no a "next" (regla 1). */
const BARE_QUE_VIENE_RE = /\s+que\s+viene\b/;

/** Minúsculas, sin acentos, sin signos de relleno — SIN tocar artículos todavía. */
function lightlyNormalize(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Separa el calificador de semana del resto de la expresión (día/fecha). */
export function parseWeekQualifier(raw: string): { qualifier: WeekQualifier; rest: string } {
  const s = lightlyNormalize(raw);
  if (NEXT_WEEK_QUALIFIER_RE.test(s)) {
    return { qualifier: "next", rest: normalizeExpression(s.replace(NEXT_WEEK_QUALIFIER_RE, " ")) };
  }
  if (SAME_WEEK_QUALIFIER_RE.test(s)) {
    return { qualifier: "same", rest: normalizeExpression(s.replace(SAME_WEEK_QUALIFIER_RE, " ")) };
  }
  return { qualifier: "none", rest: normalizeExpression(s.replace(BARE_QUE_VIENE_RE, " ")) };
}

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Día de la semana (0 = domingo) de una fecha ISO (aritmética de calendario). */
export function weekdayIndexOf(dayIso: string): number {
  return new Date(`${dayIso}T00:00:00Z`).getUTCDay();
}

/** Lunes (ISO) de la semana calendario `[lunes, domingo]` que contiene `dayIso`. */
function mondayOfWeek(dayIso: string): string {
  const wd = weekdayIndexOf(dayIso); // 0=domingo..6=sabado
  return addDaysISO(dayIso, -((wd + 6) % 7));
}

/**
 * Un día de semana + su calificador → fecha (026 §3.1). Tres rutas:
 * - `"none"`: la ocurrencia futura más cercana, NUNCA hoy (D3 de 025, sin
 *   cambio) — cubre bare, «el próximo», «que viene» (reglas 1-3, 6).
 * - `"same"`: el día de la semana calendario ACTUAL — puede ser hoy; si ya
 *   pasó, NO se reinterpreta en silencio (regla 5).
 * - `"next"`: el día de la semana calendario SIGUIENTE, siempre, exista o no
 *   ya haya pasado el de esta semana (regla 4).
 */
function resolveWeekday(weekday: number, qualifier: WeekQualifier, todayIso: string): DayResolution {
  const todayWeekday = weekdayIndexOf(todayIso);
  const offsetFromMonday = (weekday + 6) % 7; // lunes=0 .. domingo=6
  if (qualifier === "none") {
    const diff = ((weekday - todayWeekday + 7) % 7) || 7;
    return { ok: true, dayIso: addDaysISO(todayIso, diff) };
  }
  const monday = qualifier === "next" ? addDaysISO(mondayOfWeek(todayIso), 7) : mondayOfWeek(todayIso);
  const dayIso = addDaysISO(monday, offsetFromMonday);
  if (qualifier === "same" && dayIso < todayIso) {
    return { ok: false, reason: "already_passed_this_week" };
  }
  return { ok: true, dayIso };
}

/**
 * 026 — Las dos fechas candidatas de un día de semana BARE (sin calificador
 * propio): la de esta semana calendario y la de la siguiente. Para construir
 * el texto de aclaración «¿esta semana (18 sep) o la próxima (25 sep)?» —
 * `null` si `weekdayWord` no es un día de semana reconocible. Devuelve la
 * fecha de "esta semana" aunque ya haya pasado (es justo lo que hay que
 * nombrar para explicar por qué se pregunta).
 */
export function weekdayDatesThisAndNextWeek(
  weekdayWord: string,
  todayIso: string
): { same: string; next: string } | null {
  const { rest } = parseWeekQualifier(weekdayWord);
  const weekday = WEEKDAY_INDEX[rest];
  if (weekday === undefined) return null;
  const offsetFromMonday = (weekday + 6) % 7;
  const mondayThis = mondayOfWeek(todayIso);
  return {
    same: addDaysISO(mondayThis, offsetFromMonday),
    next: addDaysISO(addDaysISO(mondayThis, 7), offsetFromMonday),
  };
}

/**
 * Resuelve la expresión de día contra «hoy» (ya en la zona del negocio).
 *
 * `impliedQualifier` — 026: el calificador de semana heredado de una
 * aclaración anterior (regla 10, `agenda-clarify-context.ts`), usado SÓLO
 * cuando la expresión de ESTE turno no trae uno explícito propio (el turno
 * actual manda si hay conflicto).
 */
export function resolveDayExpression(
  raw: string,
  todayIso: string,
  impliedQualifier?: "same" | "next"
): DayResolution {
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!)
      ? { ok: true, dayIso: raw.trim() }
      : { ok: false };
  }

  const { qualifier: explicitQualifier, rest: e } = parseWeekQualifier(raw);
  if (!e) return { ok: false };

  if (e === "hoy" || e === "today") return { ok: true, dayIso: todayIso };
  if (e === "pasado manana" || e === "day after tomorrow") {
    return { ok: true, dayIso: addDaysISO(todayIso, 2) };
  }
  if (e === "manana" || e === "tomorrow") {
    return { ok: true, dayIso: addDaysISO(todayIso, 1) };
  }

  const weekday = WEEKDAY_INDEX[e];
  if (weekday !== undefined) {
    const qualifier: WeekQualifier =
      explicitQualifier !== "none" ? explicitQualifier : (impliedQualifier ?? "none");
    return resolveWeekday(weekday, qualifier, todayIso);
  }

  // «25 de septiembre», «25 sep», «25 septiembre 2026»
  const named = e.match(/^(\d{1,2})(?:\s+de)?\s+([a-z]+)(?:\s+(?:de\s+)?(\d{4}))?$/);
  if (named) {
    const month = MONTH_INDEX[named[2]!];
    if (month) return fromDayMonth(+named[1]!, month, named[3] ? +named[3] : null, todayIso);
  }
  // «25/09», «25-09», «25/09/2026»
  const numeric = e.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/);
  if (numeric) {
    return fromDayMonth(+numeric[1]!, +numeric[2]!, numeric[3] ? +numeric[3] : null, todayIso);
  }
  return { ok: false };
}

function fromDayMonth(
  day: number,
  month: number,
  year: number | null,
  todayIso: string
): DayResolution {
  if (year !== null) {
    return isRealDate(year, month, day)
      ? { ok: true, dayIso: `${year}-${pad(month)}-${pad(day)}` }
      : { ok: false };
  }
  // Sin año: la próxima vez que esa fecha exista y no haya pasado (un 29 de
  // febrero salta hasta el siguiente bisiesto).
  const todayYear = +todayIso.slice(0, 4);
  for (let y = todayYear; y <= todayYear + 4; y++) {
    if (!isRealDate(y, month, day)) continue;
    const dayIso = `${y}-${pad(month)}-${pad(day)}`;
    if (dayIso >= todayIso) return { ok: true, dayIso };
  }
  return { ok: false };
}

/* ------------------------------------------------------------------ */
/* Horas                                                               */
/* ------------------------------------------------------------------ */

export type WallInterval = { start: string; end: string };

export type TimeReading = {
  /** Lecturas posibles como "HH:MM" (una, o dos si de verdad son ambiguas). */
  candidates: string[];
  /** La marca del prospecto no decidió entre las lecturas y ambas caen en horario. */
  ambiguous: boolean;
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const fromMinutes = (min: number): string => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** ¿Ese minuto del día cae dentro de algún intervalo hábil? (inicio incluido, fin excluido) */
export function withinIntervals(hhmm: string, intervals: WallInterval[]): boolean {
  const t = toMinutes(hhmm);
  return intervals.some((iv) => t >= toMinutes(iv.start) && t < toMinutes(iv.end));
}

/**
 * Lee una hora dicha por el prospecto. Devuelve `null` si no es una hora.
 *
 * Con marca explícita (`am`, `pm`, `de la tarde`, `24 h`) la lectura es única.
 * Sin marca, una hora de 1 a 11 puede ser de la mañana o de la tarde: se queda
 * con la lectura que cae DENTRO del horario del día; si ambas caen, devuelve las
 * dos (ambiguas); si ninguna, la más verosímil (1-7 → tarde, el resto → mañana)
 * para que quien responda pueda decir «fuera de horario» con la hora real.
 */
export function parseTimeReading(raw: string, intervals: WallInterval[]): TimeReading | null {
  const e = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\bmediodia\b/.test(e)) return { candidates: ["12:00"], ambiguous: false };
  if (/\bmedianoche\b/.test(e)) return { candidates: ["00:00"], ambiguous: false };

  const m = e.match(/(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?/);
  if (!m) return null;
  let hour = Number(m[1]);
  let minute = m[2] ? Number(m[2]) : 0;
  // «4 y media», «4 y cuarto», «4 menos cuarto»: se lee lo que dijo, no la hora en punto.
  if (!m[2]) {
    if (/\by media\b/.test(e)) minute = 30;
    else if (/\by cuarto\b/.test(e)) minute = 15;
    else if (/\bmenos cuarto\b/.test(e)) {
      minute = 45;
      hour = hour === 1 ? 12 : hour - 1;
    }
  }
  if (hour > 23 || minute > 59) return null;

  const pm = /\bp\.?\s?m\b|\bpm\b|\bde la tarde\b|\bpor la tarde\b|\bde la noche\b|\bpor la noche\b|\btarde\b|\bnoche\b/.test(e);
  const am = /\ba\.?\s?m\b|\bam\b|\bde la manana\b|\bpor la manana\b|\bmanana\b/.test(e);

  const at = (h: number) => `${pad(h)}:${pad(minute)}`;

  // Formato de 24 h o marca explícita.
  if (hour >= 13 || hour === 0) return { candidates: [at(hour)], ambiguous: false };
  if (pm && !am) return { candidates: [at(hour === 12 ? 12 : hour + 12)], ambiguous: false };
  if (am && !pm) return { candidates: [at(hour === 12 ? 0 : hour)], ambiguous: false };
  if (hour === 12) return { candidates: [at(12)], ambiguous: false };

  // 1..11 sin marca: ¿mañana o tarde? Lo decide el horario del día.
  const morning = at(hour);
  const afternoon = at(hour + 12);
  const inHours = [morning, afternoon].filter((c) => withinIntervals(c, intervals));
  if (inHours.length === 1) return { candidates: inHours, ambiguous: false };
  if (inHours.length === 2) return { candidates: inHours, ambiguous: true };
  return { candidates: [hour <= 7 ? afternoon : morning], ambiguous: false };
}

/** Minutos desde medianoche de un "HH:MM" (para comparar rangos). */
export function minutesOfDay(hhmm: string): number {
  return toMinutes(hhmm);
}

export { fromMinutes as hhmmFromMinutes };
