import {
  WEEKDAYS,
  addDaysISO,
  dayLabelInTz,
  todayInTz,
  type WeekdayKey,
} from "@/lib/time/slots";
import type { CalendarSettings } from "@/server/agenda/settings";

/**
 * Incidente 2026-09-20 — el agente afirmó "las demostraciones las tenemos en
 * horario de mañana". Eso no salía de ninguna configuración ni de ningún
 * prompt: lo dedujo de que los tres huecos que vio eran a las 09:00.
 *
 * El modelo no tenía forma de saber cuándo atiende el negocio, ni siquiera qué
 * día es hoy (el prompt no llevaba ancla temporal alguna). Esto se lo da, para
 * que conteste con la verdad en vez de inferirla de una muestra de tres.
 */

const LABELS: Record<WeekdayKey, string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

export type BusinessHours = {
  /** Una línea por tramo, ya agrupada: "Lunes a viernes: 09:00–18:00". */
  lines: string[];
  /** Los días cerrados, en palabras. null si abre todos. */
  closed: string | null;
  timezone: string;
  /** El ancla temporal que el prompt no tenía: "domingo 20 de septiembre". */
  today: string;
  /** Último día agendable, según `maxDaysAhead`. */
  lastBookable: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "sábado y domingo" — enumeración natural en español. */
function enumerar(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]!}`;
}

/**
 * El horario semanal en texto corto. Agrupa corridas consecutivas de días con
 * los MISMOS intervalos para que L-V 9-18 sea una línea y no cinco: el prompt
 * se lee mejor y cuesta menos.
 */
export function renderWeeklyHours(
  settings: CalendarSettings,
  now: Date
): BusinessHours {
  const tz = settings.timezone;
  const abiertos = WEEKDAYS.filter(
    (d) => (settings.weeklyHours[d]?.length ?? 0) > 0
  );
  const cerrados = WEEKDAYS.filter(
    (d) => (settings.weeklyHours[d]?.length ?? 0) === 0
  );

  const lines: string[] = [];
  let i = 0;
  while (i < abiertos.length) {
    const inicio = i;
    const firma = JSON.stringify(settings.weeklyHours[abiertos[i]!]);
    // Avanza mientras el día siguiente sea consecutivo Y tenga el mismo horario.
    while (
      i + 1 < abiertos.length &&
      JSON.stringify(settings.weeklyHours[abiertos[i + 1]!]) === firma &&
      WEEKDAYS.indexOf(abiertos[i + 1]!) === WEEKDAYS.indexOf(abiertos[i]!) + 1
    ) {
      i++;
    }
    const rangos = (settings.weeklyHours[abiertos[inicio]!] ?? [])
      .map((iv) => `${iv.start}–${iv.end}`)
      .join(", ");
    const etiqueta =
      inicio === i
        ? capitalize(LABELS[abiertos[inicio]!])
        : `${capitalize(LABELS[abiertos[inicio]!])} a ${LABELS[abiertos[i]!]}`;
    lines.push(`${etiqueta}: ${rangos}`);
    i++;
  }

  const todayIso = todayInTz(now, tz);
  return {
    lines,
    closed: cerrados.length > 0 ? enumerar(cerrados.map((d) => LABELS[d])) : null,
    timezone: tz,
    today: dayLabelInTz(`${todayIso}T12:00:00.000Z`, tz, now),
    lastBookable: dayLabelInTz(
      `${addDaysISO(todayIso, settings.maxDaysAhead)}T12:00:00.000Z`,
      tz,
      now
    ),
  };
}
