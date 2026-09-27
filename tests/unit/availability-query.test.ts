import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  dayIsoInTz,
  eachDateInRange,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { buildCandidateSlots, filterFreeSlots } from "@/server/agenda/availability";
import {
  MAX_REGISTERED,
  answerQuery,
  claimsNoAvailability,
  type AvailabilityAnswer,
  type AvailabilityQuery,
  type DayData,
} from "@/server/agenda/availability-query";
import { resolveDayExpression } from "@/lib/time/day-expressions";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/server/agenda/settings";

/**
 * Spec 025 — el núcleo PURO de la consulta de disponibilidad. Los días se
 * construyen con las MISMAS funciones puras del motor (`buildCandidateSlots` +
 * `filterFreeSlots`): horario semanal, zona horaria, duración, buffers, aviso
 * mínimo y citas existentes. Sin BD ni mocks.
 *
 * «Ahora» = jueves 17 sep 2026, 12:00 en Ciudad de México (18:00Z).
 */

const NOW = new Date("2026-09-17T18:00:00Z");

function settingsWith(over: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...DEFAULT_CALENDAR_SETTINGS, ...over };
}

/** Los mismos pasos que `computeAvailability`, sin la lectura de citas de la BD. */
function buildDays(settings: CalendarSettings, now: Date, busy: SlotUtc[] = []) {
  const tz = settings.timezone;
  const todayIso = todayInTz(now, tz);
  const horizonEndIso = addDaysISO(todayIso, settings.maxDaysAhead);
  const candidates = buildCandidateSlots(settings, todayIso, horizonEndIso);
  const free = filterFreeSlots(candidates, busy, {
    now,
    minNoticeHours: settings.minNoticeHours,
    timezone: tz,
  });
  // Un solo `dayIsoInTz` por horario (construir un Intl por horario y día es O(n²) y lento).
  const byDay = new Map<string, typeof free>();
  for (const s of free) {
    const d = dayIsoInTz(new Date(s.startUtc), tz);
    const bucket = byDay.get(d);
    if (bucket) bucket.push(s);
    else byDay.set(d, [s]);
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
  return { days, todayIso, horizonEndIso, free };
}

function ask(
  query: AvailabilityQuery,
  opts: {
    settings?: CalendarSettings;
    now?: Date;
    busy?: SlotUtc[];
    impliedWeekModifier?: "same" | "next";
    priorClarifyAttempt?: number;
  } = {}
): AvailabilityAnswer {
  const settings = opts.settings ?? settingsWith();
  const now = opts.now ?? NOW;
  const { days, todayIso, horizonEndIso } = buildDays(settings, now, opts.busy);
  return answerQuery({
    query,
    settings,
    now,
    todayIso,
    horizonEndIso,
    days,
    impliedWeekModifier: opts.impliedWeekModifier,
    priorClarifyAttempt: opts.priorClarifyAttempt,
  });
}

/** Un bloqueo de pared en la zona del negocio. */
function block(dayIso: string, from: string, to: string, tz = "America/Mexico_City"): SlotUtc {
  return {
    startUtc: zonedWallClockToUtc(dayIso, from, tz)!.toISOString(),
    endUtc: zonedWallClockToUtc(dayIso, to, tz)!.toISOString(),
  };
}

const MON = "2026-09-21";

describe("las cuatro consultas del requisito, agenda VACÍA de 9:00 am a 6:00 pm", () => {
  it("«¿Tienes más horarios mañana?» → TODO el día, exhaustiva, sin inventar ocupación", () => {
    const a = ask({ day: "mañana" });
    expect(a.text).toBe(
      "Mañana viernes, 18 de septiembre puedo iniciar de 9:00 am a 5:30 pm (cada 30 min). Cada sesión dura 30 min."
    );
    expect(a.meta).toEqual({
      kind: "day",
      scopeComplete: true,
      exhaustive: true,
      hasMore: false,
      total: 18,
      conveyed: 18,
    });
    expect(claimsNoAvailability(a.text)).toBe(false);
    // Todos los del día quedan registrados y mostrados (el prospecto puede elegir cualquiera).
    expect(a.offers).toHaveLength(18);
    expect(a.offers.every((o) => o.shown)).toBe(true);
    expect(a.offers[0]!.startUtc).toBe("2026-09-18T15:00:00.000Z"); // 09:00 MX
    expect(a.offers.at(-1)!.startUtc).toBe("2026-09-18T23:30:00.000Z"); // 17:30 MX
    expect(a.ok).toBe(true);
    expect(a.status).toBe("availability");
  });

  it("«¿Lunes a las 11 o 12?» → ambas libres", () => {
    const a = ask({ day: "lunes", times: ["11", "12"] });
    expect(a.text).toBe("Lunes, 21 de septiembre sí tengo libre a las 11:00 am y 12:00 pm.");
    expect(a.checks).toEqual([
      { dayIso: MON, hhmm: "11:00", free: true, reason: undefined },
      { dayIso: MON, hhmm: "12:00", free: true, reason: undefined },
    ]);
    expect(a.meta).toMatchObject({ kind: "times", exhaustive: true, hasMore: false, total: 2, conveyed: 2 });
    // El día completo queda registrado para poder elegir otra hora.
    expect(a.offers).toHaveLength(18);
    expect(a.offers.filter((o) => o.shown).map((o) => o.startUtc)).toEqual([
      "2026-09-21T17:00:00.000Z",
      "2026-09-21T18:00:00.000Z",
    ]);
  });

  it("«¿El lunes a las 4 o 5 de la tarde?» → 4:00 pm y 5:00 pm libres (5:00 pm termina 5:30 pm ≤ 6:00 pm)", () => {
    for (const times of [["4 de la tarde", "5 de la tarde"], ["4", "5"], ["16:00", "17:00"], ["4 pm", "5 pm"]]) {
      const a = ask({ day: "lunes", times });
      expect(a.text, JSON.stringify(times)).toBe("Lunes, 21 de septiembre sí tengo libre a las 4:00 pm y 5:00 pm.");
      expect(a.meta.total).toBe(2);
    }
  });

  it("«¿Cuál es el horario más tarde?» → 5:30 pm (agenda vacía) y el más temprano 9:00 am", () => {
    const late = ask({ day: "lunes", edge: "latest" });
    expect(late.text).toBe("Lunes, 21 de septiembre, el horario más tarde para iniciar es a las 5:30 pm.");
    expect(late.meta).toMatchObject({ kind: "edge", exhaustive: true, total: 1 });
    const early = ask({ day: "lunes", edge: "earliest" });
    expect(early.text).toContain("más temprano para iniciar es a las 9:00 am");
  });

  it("sin día, «el más tarde» describe los primeros 3 días con agenda y DECLARA que hay más", () => {
    const a = ask({ edge: "latest" });
    // Hoy (jueves) desde las 14:00 por el aviso mínimo; luego viernes y lunes.
    expect(a.text.split("\n")).toHaveLength(4); // 3 días + la invitación a elegir
    expect(a.text).toContain("Hoy jueves, 17 de septiembre, el horario más tarde para iniciar es a las 5:30 pm.");
    expect(a.meta).toMatchObject({ kind: "edge", hasMore: true, exhaustive: false, total: 6, conveyed: 3 });
    expect(a.text).toContain("Tengo más días con horarios disponibles");
  });
});

describe("con citas y bloqueos reales, sólo lo ocupado deja de ofrecerse", () => {
  it("una comida 1:00 pm-2:00 pm el lunes: se dice ocupado, no «no hay»; el resto del día sigue libre", () => {
    const busy = [block(MON, "13:00", "14:00")];
    const a = ask({ day: "lunes", times: ["1", "2"] }, { busy });
    expect(a.checks.map((c) => [c.hhmm, c.free, c.reason])).toEqual([
      ["13:00", false, "occupied"],
      ["14:00", true, undefined],
    ]);
    expect(a.text).toContain("a las 1:00 pm ya está ocupado");
    expect(a.text).toContain("a las 2:00 pm sí tengo");
    // …y completa con TODO lo que sí hay ese día (rangos exactos).
    expect(a.text).toContain("Ese día también puedo iniciar de 9:00 am a 12:30 pm y de 2:00 pm a 5:30 pm");
  });

  it("una cita a las 5:30 pm baja el más tarde a 5:00 pm; una a las 5:00 pm lo deja en 5:30 pm", () => {
    expect(ask({ day: "lunes", edge: "latest" }, { busy: [block(MON, "17:30", "18:00")] }).text).toContain("a las 5:00 pm");
    expect(ask({ day: "lunes", edge: "latest" }, { busy: [block(MON, "17:00", "17:30")] }).text).toContain("a las 5:30 pm");
  });

  it("una cita de 60 min bloquea los DOS slots de 30 min que toca", () => {
    const a = ask({ day: "lunes", times: ["11", "11:30", "12"] }, { busy: [block(MON, "11:00", "12:00")] });
    expect(a.checks.map((c) => [c.hhmm, c.free])).toEqual([
      ["11:00", false],
      ["11:30", false],
      ["12:00", true],
    ]);
  });

  it("día completamente ocupado: SÍ es una negación honesta (día evaluado completo) y sugiere lo más cercano", () => {
    const a = ask({ day: "lunes" }, { busy: [block(MON, "09:00", "18:00")] });
    expect(a.text).toContain("Lunes, 21 de septiembre ya no me quedan horarios libres.");
    expect(claimsNoAvailability(a.text)).toBe(true);
    expect(a.meta).toMatchObject({ scopeComplete: true, total: 0, exhaustive: true, hasMore: false });
    expect(a.text).toContain("Lo más cercano que tengo:");
    expect(a.offers.length).toBeGreaterThan(0); // las cercanas quedan ofrecibles
    expect(a.offers.every((o) => o.shown)).toBe(true);
    expect(a.ok).toBe(false);
  });

  it("una hora que hoy ya no alcanza: aviso mínimo (no «ocupado»)", () => {
    const a = ask({ day: "hoy", times: ["13"] });
    expect(a.checks[0]).toMatchObject({ hhmm: "13:00", free: false, reason: "too_soon" });
    expect(a.text).toContain("no alcanzo a agendarlo (aviso mínimo de 2 h)");
    const past = ask({ day: "hoy", times: ["10"] });
    expect(past.checks[0]).toMatchObject({ free: false, reason: "past" });
    expect(past.text).toContain("ya pasó");
  });
});

describe("casos límite: cada negación tiene una causa REAL", () => {
  it("día que no atiende", () => {
    const a = ask({ day: "domingo", times: ["11"] });
    expect(a.checks[0]).toMatchObject({ reason: "closed_day" });
    expect(a.text).toContain("ese día no atiendo");
    expect(ask({ day: "domingo" }).text).toContain("Domingo, 20 de septiembre no atiendo.");
  });

  it("hora fuera de horario", () => {
    const a = ask({ day: "lunes", times: ["8 pm", "7:30"] });
    expect(a.checks.map((c) => c.reason)).toEqual(["out_of_hours", "out_of_hours"]);
    expect(a.text).toContain("queda fuera de mi horario (9:00 am a 6:00 pm)");
  });

  it("hora fuera de la rejilla: explica los inicios reales en vez de decir «ocupado»", () => {
    const a = ask({ day: "lunes", times: ["11:15"] });
    expect(a.checks[0]).toMatchObject({ free: false, reason: "off_grid" });
    expect(a.text).toContain("no coincide con mis horarios de inicio (cada 30 min: 11:00 am o 11:30 am)");
  });

  it("fecha pasada y fuera de horizonte: no afirman disponibilidad ni la niegan", () => {
    const past = ask({ day: "2026-09-10" });
    expect(past.text).toContain("ya pasó");
    expect(past.meta).toMatchObject({ kind: "none", scopeComplete: false, total: 0, exhaustive: false });
    expect(past.offers).toEqual([]);
    const far = ask({ day: "2026-10-30" });
    expect(far.text).toContain("Por ahora agendo hasta el jueves, 24 de septiembre");
    expect(far.meta.kind).toBe("none");
    expect(claimsNoAvailability(far.text)).toBe(false); // «agendo hasta…» no es «no hay»
  });

  it("no entiende el día o la hora: PREGUNTA, no ofrece ni afirma nada", () => {
    const d = ask({ day: "la semana que viene" });
    expect(d.status).toBe("availability_clarify");
    expect(d.offers).toEqual([]);
    expect(d.meta).toMatchObject({ kind: "clarify", total: 0, hasMore: false });
    const t = ask({ day: "lunes", times: ["por la tarde"] });
    expect(t.status).toBe("availability_clarify");
    const r = ask({ day: "lunes", from: "pronto" });
    expect(r.status).toBe("availability_clarify");
  });

  it("sin día: la pregunta de una hora se responde sobre el horizonte y declara los días omitidos", () => {
    const a = ask({ times: ["11"] });
    // Hoy 11:00 ya pasó; libres: vie 18, lun 21, mar 22, mié 23, jue 24 → se describen 3.
    expect(a.meta).toMatchObject({ kind: "times", total: 5, hasMore: true, exhaustive: false });
    expect(a.text).toContain("Tengo más días con horarios disponibles");
  });

  it("sin día y sin nada que cumpla en TODO el horizonte: negación honesta con el alcance dicho", () => {
    const a = ask({ times: ["11"] }, { settings: settingsWith({ weeklyHours: { mon: [{ start: "14:00", end: "18:00" }] } }) });
    expect(a.text).toContain("No tengo libre a esa hora en los próximos 7 días.");
    expect(a.meta).toMatchObject({ scopeComplete: true, total: 0, exhaustive: true });
  });
});

describe("026 — días alternativos (`days[]`)", () => {
  it("«jueves o viernes» (sin calificador): ocurrencias más cercanas, EN EL ORDEN DEL CLIENTE", () => {
    // Hoy es jueves 17: el jueves más cercano es el 24 (nunca hoy); el viernes es mañana (18).
    // El texto debe listar el jueves PRIMERO aunque su fecha caiga después (regla del dueño).
    const a = ask({ days: ["jueves", "viernes"] });
    expect(a.meta.kind).toBe("days");
    const lines = a.text.split("\n");
    expect(lines[0]).toContain("Jueves, 24 de septiembre");
    expect(lines[1]).toContain("18 de septiembre"); // "Mañana viernes, 18…" (dayLabelInTz)
    expect(a.ok).toBe(true);
  });

  it("«jueves o viernes de la próxima semana»: ambos dentro de esa semana (regla 4 aplicada a los dos)", () => {
    const a = ask({ days: ["jueves de la próxima semana", "viernes de la próxima semana"] });
    const lines = a.text.split("\n");
    expect(lines[0]).toContain("Jueves, 24 de septiembre");
    expect(lines[1]).toContain("Viernes, 25 de septiembre");
  });

  it("un día dentro del horizonte y otro fuera: cada uno se explica por separado, sin negar el que sí hay (regla 13)", () => {
    // Horizonte por defecto termina el jueves 24. "1 de octubre" cae fuera.
    const a = ask({ days: ["lunes", "1 de octubre"] });
    expect(a.text).toContain("Lunes, 21 de septiembre puedo iniciar");
    expect(a.text).toContain("está fuera de mi horizonte");
    expect(a.meta.total).toBeGreaterThan(0); // el lunes SÍ cuenta
    expect(a.ok).toBe(true);
  });

  it("un día completamente ocupado entre varios: se explica su causa, no se omite en silencio", () => {
    const a = ask({ days: ["lunes", "martes"] }, { busy: [block(MON, "09:00", "18:00")] });
    expect(a.text).toContain("Lunes, 21 de septiembre ya no me quedan horarios libres.");
    expect(a.text).toContain("Martes, 22 de septiembre puedo iniciar");
  });

  it("más de 3 días: pide que elija, sin evaluar nada", () => {
    const a = ask({ days: ["lunes", "martes", "miércoles", "jueves"] });
    expect(a.status).toBe("availability_clarify");
    expect(a.clarify?.reason).toBe("too_many_days");
    expect(a.text).toContain("hasta 3 días");
  });

  it("`days` con un solo elemento se comporta como `day`", () => {
    const a = ask({ days: ["lunes"] });
    expect(a.meta.kind).toBe("day");
  });
});

describe("026 — aclaración: calificador de semana, contexto y variación (reglas 5, 10, 14)", () => {
  it("«este lunes» (ya pasó esta semana): NO se reinterpreta en silencio — pide aclaración con la fecha real", () => {
    const a = ask({ day: "este lunes" }); // hoy es jueves 17; el lunes de esta semana (14) ya pasó
    expect(a.status).toBe("availability_clarify");
    expect(a.clarify?.reason).toBe("already_passed_this_week");
    expect(a.text).toContain("ya pasó");
    expect(a.text).toContain("próxima semana");
    expect(a.offers).toEqual([]);
    expect(a.clarify?.context).toEqual({ days: ["este lunes"] });
  });

  it("segundo intento consecutivo de la MISMA razón: texto corto, nunca repetido", () => {
    const first = ask({ day: "este lunes" }, { priorClarifyAttempt: 1 });
    const second = ask({ day: "este lunes" }, { priorClarifyAttempt: 2 });
    expect(second.text).not.toBe(first.text);
    expect(second.text).toBe("¿Esta semana o la próxima?");
  });

  it("«la semana que viene» sin día: aclara y RECUERDA el calificador (para heredarlo en el turno siguiente)", () => {
    const a = ask({ day: "la semana que viene" });
    expect(a.status).toBe("availability_clarify");
    expect(a.clarify?.reason).toBe("unresolved_day");
    expect(a.clarify?.context).toEqual({ weekModifier: "next" });
  });

  it("heredar el calificador: «el viernes» + impliedWeekModifier:'next' resuelve a la semana SIGUIENTE", () => {
    // "jueves" no sirve de ejemplo aquí: hoy ES jueves, así que bare y "next" coinciden
    // por coincidencia aritmética (ambos saltan +7 días). "viernes" sí los distingue.
    const bare = ask({ day: "viernes" });
    expect(bare.text).toContain("18 de septiembre"); // mañana, esta semana
    // El viernes de la semana SIGUIENTE (25 sep) cae fuera del horizonte por defecto (7 días,
    // termina el 24): la herencia del calificador NUNCA inventa disponibilidad — dice la
    // verdad del horizonte en vez de fingir que el 25 está disponible (regla 9 / AC-11).
    const inherited = ask({ day: "viernes" }, { impliedWeekModifier: "next" });
    expect(inherited.meta.kind).toBe("none");
    expect(inherited.text).toContain("Por ahora agendo hasta el jueves, 24 de septiembre");

    // Con un horizonte más ancho, sí se resuelve al viernes de la semana siguiente (25 sep).
    const wideHorizon = settingsWith({ maxDaysAhead: 14 });
    const inheritedWide = ask({ day: "viernes" }, { impliedWeekModifier: "next", settings: wideHorizon });
    expect(inheritedWide.text).toContain("25 de septiembre");
  });

  it("segunda aclaración de hora/rango sin resolver: varía el texto también", () => {
    const t1 = ask({ day: "lunes", times: ["por la tarde"] }, { priorClarifyAttempt: 1 });
    const t2 = ask({ day: "lunes", times: ["por la tarde"] }, { priorClarifyAttempt: 2 });
    expect(t1.clarify?.reason).toBe("unresolved_time");
    expect(t2.text).not.toBe(t1.text);
    const r1 = ask({ day: "lunes", from: "pronto" }, { priorClarifyAttempt: 1 });
    const r2 = ask({ day: "lunes", from: "pronto" }, { priorClarifyAttempt: 2 });
    expect(r1.clarify?.reason).toBe("unresolved_range");
    expect(r2.text).not.toBe(r1.text);
  });

  /** Cuenta patrones de fecha "N de <mes>" en un texto (oráculo simple, independiente del código). */
  const DATE_PATTERN = /\d{1,2}\s+de\s+[a-záéíóúñ]+/gi;
  const countDates = (text: string) => (text.match(DATE_PATTERN) ?? []).length;

  it("regla del dueño: NUNCA más de 2 fechas concretas dentro de una misma aclaración (nunca cartesiana)", () => {
    // Un solo día ya pasado: como mucho la fecha de "esta semana" que pasó.
    const single = ask({ day: "este lunes" });
    expect(countDates(single.text)).toBeLessThanOrEqual(2);
    // Dos días alternativos, AMBOS ya pasados esta semana (ambigüedad de semana COMPARTIDA):
    // la pregunta corta nunca enumera las 4 fechas posibles (2 días × 2 semanas).
    const double = ask({ days: ["este lunes", "este martes"] });
    expect(double.clarify?.reason).toBe("already_passed_this_week");
    expect(countDates(double.text)).toBeLessThanOrEqual(2);
    // El segundo intento (pregunta corta) nunca trae ninguna fecha.
    const repeat = ask({ days: ["este lunes", "este martes"] }, { priorClarifyAttempt: 2 });
    expect(countDates(repeat.text)).toBe(0);
    expect(repeat.text).toBe("¿Esta semana o la próxima?");
  });
});

describe("rangos", () => {
  it("«entre las 2 y las 5 de la tarde» → inicio ≥ 2:00 pm y FIN ≤ 5:00 pm", () => {
    const a = ask({ day: "lunes", from: "2 pm", to: "5 pm" });
    expect(a.text).toContain("entre esas horas puedo iniciar de 2:00 pm a 4:30 pm (cada 30 min)");
    expect(a.meta).toMatchObject({ kind: "range", total: 6, exhaustive: true });
  });

  it("sólo «después de las 3»", () => {
    const a = ask({ day: "lunes", from: "3 pm" });
    expect(a.text).toContain("de 3:00 pm a 5:30 pm");
    expect(a.meta.total).toBe(6);
  });

  it("sólo «antes de las 11»", () => {
    const a = ask({ day: "lunes", to: "11" });
    expect(a.text).toContain("de 9:00 am a 10:30 am");
  });

  it("rango sin coincidencias: lo dice y muestra lo que SÍ hay ese día (día evaluado completo)", () => {
    const a = ask({ day: "lunes", from: "7 pm", to: "9 pm" });
    expect(a.text).toContain("no tengo horarios dentro de ese rango");
    expect(a.text).toContain("Ese día sí puedo iniciar de 9:00 am a 5:30 pm");
    expect(a.meta).toMatchObject({ total: 0, scopeComplete: true });
    expect(a.offers).toHaveLength(18);
  });

  it("rango + extremo: «lo más tarde antes de las 4»", () => {
    const a = ask({ day: "lunes", to: "4 pm", edge: "latest" });
    expect(a.text).toContain("a las 3:30 pm"); // el último inicio cuyo fin (16:00) ≤ 16:00
  });
});

describe("zona horaria, horario partido, duración y buffers", () => {
  it("zona distinta a la del servidor: 9:00 am de Tokio es 12:00 amZ y «mañana» es el mañana de TOKIO", () => {
    const tokyo = settingsWith({
      timezone: "Asia/Tokyo",
      weeklyHours: Object.fromEntries(
        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "09:00", end: "18:00" }]])
      ),
    });
    // 18:00Z del 17 = 03:00 del 18 en Tokio → hoy=18, mañana=19.
    const a = ask({ day: "mañana", times: ["9"] }, { settings: tokyo });
    expect(a.checks[0]).toMatchObject({ dayIso: "2026-09-19", hhmm: "09:00", free: true });
    expect(a.offers[0]!.startUtc).toBe("2026-09-19T00:00:00.000Z");
    expect(a.text).toContain("sábado, 19 de septiembre");
  });

  it("zona con horario de verano (Los Ángeles, UTC-7 en septiembre)", () => {
    const la = settingsWith({ timezone: "America/Los_Angeles" });
    const a = ask({ day: "lunes", times: ["9"] }, { settings: la });
    expect(a.offers.find((o) => o.shown)!.startUtc).toBe("2026-09-21T16:00:00.000Z");
  });

  it("horario partido 09-13 y 15-19: rangos por tramo y el hueco del mediodía es «fuera de horario»", () => {
    const split = settingsWith({
      weeklyHours: { mon: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] },
    });
    const day = ask({ day: "lunes" }, { settings: split });
    expect(day.text).toContain("de 9:00 am a 12:30 pm y de 3:00 pm a 6:30 pm (cada 30 min)");
    const gap = ask({ day: "lunes", times: ["2 de la tarde"] }, { settings: split });
    expect(gap.checks[0]).toMatchObject({ reason: "out_of_hours" });
    expect(gap.text).toContain("queda fuera de mi horario (9:00 am a 1:00 pm y 3:00 pm a 7:00 pm)");
  });

  it("duración 45 min + buffer 15: inicios cada 60 min y el último que CABE (5:00 pm termina 5:45 pm)", () => {
    const s = settingsWith({ slotMinutes: 45, bufferMinutes: 15 });
    const a = ask({ day: "lunes" }, { settings: s });
    expect(a.text).toContain("de 9:00 am a 5:00 pm (cada 60 min)");
    expect(a.text).toContain("Cada sesión dura 45 min.");
    const off = ask({ day: "lunes", times: ["9:30"] }, { settings: s });
    expect(off.checks[0]).toMatchObject({ reason: "off_grid" });
    expect(off.text).toContain("cada 60 min");
    expect(ask({ day: "lunes", edge: "latest" }, { settings: s }).text).toContain("a las 5:00 pm");
  });

  it("aviso mínimo de 24 h: mañana temprano ya no se ofrece", () => {
    const s = settingsWith({ minNoticeHours: 24 });
    const a = ask({ day: "mañana", times: ["9", "13"] }, { settings: s });
    // Ahora = jue 12:00; +24 h = vie 12:00 → 09:00 no; 13:00 sí.
    expect(a.checks.map((c) => [c.hhmm, c.free, c.reason])).toEqual([
      ["09:00", false, "too_soon"],
      ["13:00", true, undefined],
    ]);
  });

  it("un día con MÁS de 60 inicios: se registra el tope y se DECLARA (hasMore), sin fingir que es todo", () => {
    const dense = settingsWith({
      slotMinutes: 10,
      weeklyHours: { mon: [{ start: "08:00", end: "20:00" }] }, // 72 inicios
    });
    const a = ask({ day: "lunes" }, { settings: dense });
    expect(a.meta).toMatchObject({ total: 72, conveyed: MAX_REGISTERED, hasMore: true, exhaustive: false });
    expect(a.offers).toHaveLength(MAX_REGISTERED);
    expect(a.text).toContain("Tengo más horarios ese día");
  });
});

describe("claimsNoAvailability (guard de una negación escrita por el modelo)", () => {
  it.each([
    "Lo siento, no tengo más horarios disponibles.",
    "Por ahora no me quedan horarios libres.",
    "No hay horarios para mañana.",
    "La agenda está llena esta semana.",
    "No hay disponibilidad ese día.",
    "Ya no tenemos disponibilidad de horarios.",
  ])("detecta «%s»", (t) => {
    expect(claimsNoAvailability(t)).toBe(true);
  });

  it.each([
    "Claro, aquí tienes algunos horarios disponibles:",
    "Mañana tengo libre a las 11:00 am.",
    "No tengo disponibilidad de stock de ese producto.",
    "No hay problema, con gusto te ayudo.",
    "¿Qué horarios te acomodan?",
    "Por ahora agendo hasta el jueves 24.",
  ])("no confunde «%s»", (t) => {
    expect(claimsNoAvailability(t)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Propiedades: nunca se inventa ocupación ni disponibilidad.            */
/* ------------------------------------------------------------------ */

/** PRNG determinista (mulberry32): la prueba es reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("propiedades sobre 150 agendas y consultas aleatorias", () => {
  const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

  it("lo que dice coincide con lo que hay: nada inventado, ninguna negación falsa", () => {
    const r = rng(2026);
    const zones = ["America/Mexico_City", "America/Bogota", "Asia/Tokyo", "America/Los_Angeles", "Europe/Madrid"];
    const dayExprs = [undefined, "hoy", "mañana", "lunes", "martes", "viernes", "domingo", "2026-09-22", "25 de septiembre", "2026-11-01", "no sé"];
    const timeTokens = ["9", "11", "12", "1", "4", "5", "16:30", "4 de la tarde", "8 pm", "10:15", "7"];
    let negations = 0;
    let questions = 0;

    for (let i = 0; i < 150; i++) {
      const tz = pick(r, zones);
      const weekly: CalendarSettings["weeklyHours"] = {};
      for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
        const roll = r();
        if (roll < 0.25) continue; // día cerrado
        weekly[d] =
          roll < 0.5
            ? [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }]
            : [{ start: pick(r, ["08:00", "09:00", "10:00"]), end: pick(r, ["17:00", "18:00", "20:00"]) }];
      }
      const settings = settingsWith({
        timezone: tz,
        weeklyHours: weekly,
        slotMinutes: pick(r, [15, 30, 45, 60]),
        bufferMinutes: pick(r, [0, 0, 5, 15]),
        minNoticeHours: pick(r, [0, 1, 2, 24]),
        maxDaysAhead: pick(r, [3, 5, 7]),
      });
      const now = new Date(Date.UTC(2026, 8, 17, Math.floor(r() * 24), pick(r, [0, 30])));
      const todayIso = todayInTz(now, tz);
      const span = eachDateInRange(todayIso, addDaysISO(todayIso, settings.maxDaysAhead));
      const busy: SlotUtc[] = [];
      for (let b = 0; b < Math.floor(r() * 7); b++) {
        const d = span[Math.floor(r() * span.length)]!;
        const h = 8 + Math.floor(r() * 11);
        busy.push(block(d, `${String(h).padStart(2, "0")}:00`, `${String(h + 1 + Math.floor(r() * 2)).padStart(2, "0")}:00`, tz));
      }
      const truth = buildDays(settings, now, busy);
      const freeSet = new Set(truth.free.map((s) => s.startUtc));

      const q: AvailabilityQuery = {};
      const dExpr = pick(r, dayExprs);
      if (dExpr) q.day = dExpr;
      const shape = r();
      if (shape < 0.4) q.times = [pick(r, timeTokens), pick(r, timeTokens)];
      else if (shape < 0.55) q.edge = pick(r, ["earliest", "latest"] as const);
      else if (shape < 0.7) {
        q.from = pick(r, timeTokens);
        if (r() < 0.6) q.to = pick(r, ["6 pm", "5 pm", "12", "3 pm"]);
      }
      const a = answerQuery({
        query: q,
        settings,
        now,
        todayIso,
        horizonEndIso: addDaysISO(todayIso, settings.maxDaysAhead),
        days: truth.days,
      });
      const ctxLabel = `caso ${i} ${JSON.stringify(q)} tz=${tz}`;
      questions++;

      // (P1) NUNCA se ofrece un horario que el motor no tiene libre.
      for (const o of a.offers) expect(freeSet.has(o.startUtc), `${ctxLabel}: ofrece ${o.startUtc} que no está libre`).toBe(true);
      // (P2) …ni se dice ocupado/libre lo contrario de la verdad.
      for (const c of a.checks) {
        const iso = zonedWallClockToUtc(c.dayIso, c.hhmm, tz)!.toISOString();
        expect(c.free, `${ctxLabel}: ${c.dayIso} ${c.hhmm}`).toBe(freeSet.has(iso));
        expect(Boolean(c.reason)).toBe(!c.free);
      }
      // (P3) shown ⊆ offers, tope y consistencia de la metadata.
      expect(a.offers.length).toBeLessThanOrEqual(MAX_REGISTERED);
      expect(a.meta.exhaustive, ctxLabel).toBe(a.meta.scopeComplete && !a.meta.hasMore);
      expect(a.meta.conveyed).toBeLessThanOrEqual(Math.max(a.meta.total, a.offers.length));
      if (a.meta.hasMore) expect(a.meta.exhaustive).toBe(false);
      // (P4) una negación de agenda SÓLO con el alcance completo y cero coincidencias.
      if (claimsNoAvailability(a.text)) {
        negations++;
        expect(a.meta.scopeComplete, `${ctxLabel}: negación sin alcance completo → ${a.text}`).toBe(true);
        expect(a.meta.total, `${ctxLabel}: negación con coincidencias → ${a.text}`).toBe(0);
      }
      // (P5) `total` es la cuenta REAL de lo que cumple (todos los matches están libres).
      for (const m of a.matches) expect(freeSet.has(m.startUtc), ctxLabel).toBe(true);
      expect(a.matches.length).toBe(a.meta.total);
      // (P6) una respuesta de aclaración/fuera de horizonte jamás registra ni afirma.
      if (a.meta.kind === "clarify" || a.meta.kind === "none") {
        expect(a.offers).toEqual([]);
        expect(a.meta.total).toBe(0);
      }
    }
    expect(questions).toBe(150);
    // La prueba de verdad ejercita ambas ramas (no es vacua).
    expect(negations).toBeGreaterThanOrEqual(3);
  }, 90_000);
});

/* ------------------------------------------------------------------ */
/* 026 T22 — Barrido amplio: calificador de semana, `days[]`, límites  */
/* de semana/mes/año en America/Mexico_City. Reloj FIJO (9 anclas,     */
/* cubren los 7 días de la semana como "hoy" + un cruce de mes/año +   */
/* un año bisiesto) y semilla reproducible (mulberry32, ver `rng`).    */
/* ------------------------------------------------------------------ */

describe("026 — barrido amplio: calificador de semana y días alternativos", () => {
  /** 2026-09-13..19 cubre domingo..sábado UNA vez cada uno; los otros dos cruzan mes/año/bisiesto. */
  const ANCHORS = [
    "2026-09-13", // domingo
    "2026-09-14", // lunes
    "2026-09-15", // martes
    "2026-09-16", // miércoles
    "2026-09-17", // jueves — "hoy es jueves" (regla 3)
    "2026-09-18", // viernes
    "2026-09-19", // sábado
    "2026-12-29", // martes — cruza a enero del año siguiente dentro del horizonte
    "2028-02-27", // domingo — año bisiesto, cruza a marzo
  ];
  const VARIANTS_PER_ANCHOR = 17; // 9 × 17 = 153 ≥ 150
  const SWEEP_SEED = 20260926;

  /** Oráculo INDEPENDIENTE (aritmética propia, no reutiliza el código bajo prueba). */
  function expectedThursdayDates(todayIso: string) {
    const todayWd = new Date(`${todayIso}T00:00:00Z`).getUTCDay();
    const mondayThis = addDaysISO(todayIso, -((todayWd + 6) % 7));
    const same = addDaysISO(mondayThis, 3); // jueves de ESTA semana calendario
    const next = addDaysISO(mondayThis, 10); // jueves de la semana SIGUIENTE
    const diff = ((4 - todayWd + 7) % 7) || 7;
    const nearest = addDaysISO(todayIso, diff); // ocurrencia más cercana, nunca hoy
    return { same, next, nearest };
  }
  function expectedFridayDates(todayIso: string) {
    const todayWd = new Date(`${todayIso}T00:00:00Z`).getUTCDay();
    const mondayThis = addDaysISO(todayIso, -((todayWd + 6) % 7));
    const same = addDaysISO(mondayThis, 4);
    const next = addDaysISO(mondayThis, 11);
    const diff = ((5 - todayWd + 7) % 7) || 7;
    const nearest = addDaysISO(todayIso, diff);
    return { same, next, nearest };
  }

  it("cubre los 7 días de la semana como fecha actual (auto-chequeo de las anclas)", () => {
    const weekdays = new Set(ANCHORS.slice(0, 7).map((d) => new Date(`${d}T00:00:00Z`).getUTCDay()));
    expect(weekdays.size).toBe(7);
  });

  it("«jueves»/«el jueves»/«este jueves»/«jueves que viene»/«jueves de la próxima semana», «jueves o viernes» [de la próxima semana]: 150+ casos reproducibles, sin inventar nada", () => {
    const r = rng(SWEEP_SEED);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    let cases = 0;
    let alreadyPassedCases = 0;
    let multiDayOrderChecks = 0;

    for (const anchorIso of ANCHORS) {
      const now = new Date(`${anchorIso}T18:00:00Z`); // 18:00Z = mediodía CDMX (mismo criterio que NOW arriba)
      for (let v = 0; v < VARIANTS_PER_ANCHOR; v++) {
        cases++;
        const weekly: CalendarSettings["weeklyHours"] = {};
        for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
          const roll = r();
          if (roll < 0.2) continue; // día cerrado (huecos "fuera de horario" reales)
          weekly[d] = [{ start: pick(["08:00", "09:00", "10:00"]), end: pick(["16:00", "18:00", "20:00"]) }];
        }
        const settings = settingsWith({
          timezone: "America/Mexico_City", // fijo a propósito: límites de semana en ESTA zona (pedido del dueño)
          weeklyHours: weekly,
          slotMinutes: pick([15, 30, 45, 60]),
          bufferMinutes: pick([0, 0, 5, 15]),
          minNoticeHours: pick([0, 1, 2, 24]),
          maxDaysAhead: pick([3, 5, 7, 10, 14, 21]), // algunos < 7 (fuerza "fuera de horizonte"), otros ≥ 14
        });
        const busy: SlotUtc[] = [];
        for (let b = 0; b < Math.floor(r() * 5); b++) {
          const dayIso = addDaysISO(anchorIso, Math.floor(r() * settings.maxDaysAhead));
          const h = 8 + Math.floor(r() * 11);
          busy.push(block(dayIso, `${String(h).padStart(2, "0")}:00`, `${String(h + 1).padStart(2, "0")}:00`, "America/Mexico_City"));
        }
        const truth = buildDays(settings, now, busy);
        const freeSet = new Set(truth.free.map((s) => s.startUtc));
        const ctxLabel = `ancla=${anchorIso} v=${v} maxDaysAhead=${settings.maxDaysAhead}`;
        const { todayIso, horizonEndIso, days } = truth;
        const ask = (query: AvailabilityQuery) =>
          answerQuery({ query, settings, now, todayIso, horizonEndIso, days });

        const expThu = expectedThursdayDates(todayIso);

        // 1) Las 5 formas de "jueves": bare/"el"/"que viene" coinciden con el más cercano (reglas 1,2,3,6).
        for (const variant of ["jueves", "el jueves", "jueves que viene"]) {
          const resolved = resolveDayExpression(variant, todayIso);
          expect(resolved, `${ctxLabel} «${variant}»`).toEqual({ ok: true, dayIso: expThu.nearest });
        }
        // 2) "este jueves": semana ACTUAL — si ya pasó, NUNCA se reinterpreta en silencio (regla 5).
        const esteJueves = resolveDayExpression("este jueves", todayIso);
        if (expThu.same >= todayIso) {
          expect(esteJueves, `${ctxLabel} «este jueves» (no ha pasado)`).toEqual({ ok: true, dayIso: expThu.same });
        } else {
          expect(esteJueves, `${ctxLabel} «este jueves» (ya pasó)`).toEqual({
            ok: false,
            reason: "already_passed_this_week",
          });
          alreadyPassedCases++;
        }
        // 3) "jueves de la próxima semana": SIEMPRE la semana calendario siguiente (regla 4).
        const jueProxima = resolveDayExpression("jueves de la próxima semana", todayIso);
        expect(jueProxima, `${ctxLabel} «jueves de la próxima semana»`).toEqual({ ok: true, dayIso: expThu.next });

        // 4) Contra el motor: cada resolución dentro del horizonte nunca inventa ni niega de más.
        for (const variant of ["jueves", "este jueves", "jueves de la próxima semana"]) {
          const resolved = resolveDayExpression(variant, todayIso);
          if (!resolved.ok || resolved.dayIso < todayIso || resolved.dayIso > horizonEndIso) continue;
          const a = ask({ day: variant });
          for (const m of a.matches) expect(freeSet.has(m.startUtc), `${ctxLabel} «${variant}» inventó ${m.startUtc}`).toBe(true);
          for (const o of a.offers) expect(freeSet.has(o.startUtc), `${ctxLabel} «${variant}» ofreció ${o.startUtc} no libre`).toBe(true);
          if (claimsNoAvailability(a.text)) {
            expect(a.meta.scopeComplete, `${ctxLabel} «${variant}» negación sin alcance completo`).toBe(true);
            expect(a.meta.total, `${ctxLabel} «${variant}» negación con coincidencias`).toBe(0);
          }
        }

        // 5) «jueves o viernes» [de la próxima semana]: orden del CLIENTE (no cronológico), sin inventar.
        for (const suffix of ["", " de la próxima semana"]) {
          const tokenThu = `jueves${suffix}`;
          const tokenFri = `viernes${suffix}`;
          const expFri = expectedFridayDates(todayIso);
          const resThu = suffix ? expThu.next : expThu.nearest;
          const resFri = suffix ? expFri.next : expFri.nearest;
          const thuInScope = resThu >= todayIso && resThu <= horizonEndIso;
          const friInScope = resFri >= todayIso && resFri <= horizonEndIso;
          const thuHasFree = thuInScope && (days.find((d) => d.dayIso === resThu)?.free.length ?? 0) > 0;
          const friHasFree = friInScope && (days.find((d) => d.dayIso === resFri)?.free.length ?? 0) > 0;
          if (thuHasFree && friHasFree && resThu !== resFri) {
            multiDayOrderChecks++;
            const forward = ask({ days: [tokenThu, tokenFri] });
            const backward = ask({ days: [tokenFri, tokenThu] });
            const firstDayOf = (a: AvailabilityAnswer, tz: string) => dayIsoInTz(new Date(a.matches[0]!.startUtc), tz);
            expect(firstDayOf(forward, "America/Mexico_City"), `${ctxLabel} orden jueves-viernes${suffix}`).toBe(resThu);
            expect(firstDayOf(backward, "America/Mexico_City"), `${ctxLabel} orden viernes-jueves${suffix}`).toBe(resFri);
            for (const m of [...forward.matches, ...backward.matches]) {
              expect(freeSet.has(m.startUtc), `${ctxLabel} days[] inventó ${m.startUtc}`).toBe(true);
            }
          }
        }
      }
    }

    expect(cases).toBeGreaterThanOrEqual(150);
    // La prueba de verdad ejercita el caso "ya pasó" (regla 5) y el de orden en days[] (no es vacua).
    expect(alreadyPassedCases).toBeGreaterThan(0);
    expect(multiDayOrderChecks).toBeGreaterThan(0);
  }, 120_000);
});
