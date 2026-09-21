import { describe, expect, it } from "vitest";
import {
  buildCandidateSlots,
  filterFreeSlots,
} from "@/server/agenda/availability";
import {
  DEFAULT_CALENDAR_SETTINGS,
  normalizeWeeklyHours,
  type CalendarSettings,
} from "@/server/agenda/settings";
import {
  daysWithAgenda,
  pickAcrossDays,
  pickWithinDay,
  slotsOnDay,
  spreadByDay,
} from "@/server/agenda/spread";

/** 015 — El motor: horario − ocupado, con aviso mínimo. Sin BD ni reloj real. */

const MX = "America/Mexico_City";

function settings(over: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...DEFAULT_CALENDAR_SETTINGS, ...over };
}

describe("buildCandidateSlots", () => {
  it("solo genera slots en los días con horario (L-V por defecto)", () => {
    // 2026-08-08 es sábado; 2026-08-10 lunes.
    const slots = buildCandidateSlots(settings(), "2026-08-08", "2026-08-10");
    const días = new Set(slots.map((s) => s.startUtc.slice(0, 10)));
    expect(días.has("2026-08-08")).toBe(false); // sábado cerrado
    expect(días.has("2026-08-09")).toBe(false); // domingo cerrado
    expect(días.size).toBeGreaterThan(0); // el lunes sí
  });

  it("respeta la duración configurada", () => {
    const cortos = buildCandidateSlots(
      settings({ slotMinutes: 30 }),
      "2026-08-05",
      "2026-08-05"
    );
    const largos = buildCandidateSlots(
      settings({ slotMinutes: 60 }),
      "2026-08-05",
      "2026-08-05"
    );
    // 09:00-18:00 ⇒ 18 slots de 30 min, 9 de 60.
    expect(cortos).toHaveLength(18);
    expect(largos).toHaveLength(9);
  });

  it("un horario vacío no genera nada (negocio sin configurar días)", () => {
    expect(
      buildCandidateSlots(
        settings({ weeklyHours: {} }),
        "2026-08-03",
        "2026-08-07"
      )
    ).toEqual([]);
  });
});

describe("filterFreeSlots", () => {
  const tz = MX;
  const candidates = buildCandidateSlots(
    settings(),
    "2026-08-05",
    "2026-08-05"
  );

  it("descarta lo que no cumple el aviso mínimo", () => {
    // "Ahora" son las 09:00 locales del mismo día, con 2 h de aviso ⇒ el
    // primer hueco ofrecible es a las 11:00 locales (17:00Z).
    const now = new Date("2026-08-05T15:00:00.000Z");
    const free = filterFreeSlots(candidates, [], {
      now,
      minNoticeHours: 2,
      timezone: tz,
    });
    expect(free[0]!.startUtc).toBe("2026-08-05T17:00:00.000Z");
  });

  it("sin aviso mínimo ofrece desde el instante actual", () => {
    const now = new Date("2026-08-05T15:00:00.000Z");
    const free = filterFreeSlots(candidates, [], {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    expect(free[0]!.startUtc).toBe("2026-08-05T15:00:00.000Z");
  });

  it("una cita ocupada retira su hueco y solo ese", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const ocupado = [
      {
        startUtc: "2026-08-05T16:00:00.000Z",
        endUtc: "2026-08-05T16:30:00.000Z",
      },
    ];
    const libres = filterFreeSlots(candidates, ocupado, {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    const inicios = libres.map((s) => s.startUtc);
    expect(inicios).not.toContain("2026-08-05T16:00:00.000Z");
    expect(inicios).toContain("2026-08-05T16:30:00.000Z");
    expect(inicios).toContain("2026-08-05T15:30:00.000Z");
  });

  it("un bloqueo largo retira todos los huecos que toca", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const bloqueo = [
      {
        startUtc: "2026-08-05T15:00:00.000Z",
        endUtc: "2026-08-05T17:00:00.000Z", // 2 h ⇒ 4 slots de 30
      },
    ];
    const libres = filterFreeSlots(candidates, bloqueo, {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    expect(libres).toHaveLength(candidates.length - 4);
  });

  it("devuelve los huecos ordenados y etiquetados", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const libres = filterFreeSlots([...candidates].reverse(), [], {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    const tiempos = libres.map((s) => Date.parse(s.startUtc));
    expect([...tiempos].sort((a, b) => a - b)).toEqual(tiempos);
    expect(libres[0]!.label).toContain("09:00");
  });

  it("agenda llena ⇒ lista vacía, no error", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const todo = candidates.map((c) => ({
      startUtc: c.startUtc,
      endUtc: c.endUtc,
    }));
    expect(
      filterFreeSlots(candidates, todo, {
        now,
        minNoticeHours: 0,
        timezone: tz,
      })
    ).toEqual([]);
  });
});

/**
 * Sin reparto, los primeros huecos se los come el día de hoy y quien ofrece se
 * queda sin nada que decir cuando el lead pide otro día.
 */
describe("spreadByDay", () => {
  // 14:00Z son las 08:00 en México: "hoy" es el miércoles 5, no la víspera.
  // (Con 00:00Z el día local del negocio sería todavía el 4 — el motor decide
  // el día en la zona del negocio, no en la del servidor.)
  const now = new Date("2026-08-05T14:00:00.000Z");
  // Mié 5 a vie 7 de agosto, 09:00-18:00, citas de 30 ⇒ 18 huecos por día.
  const libres = filterFreeSlots(
    buildCandidateSlots(settings(), "2026-08-05", "2026-08-07"),
    [],
    { now, minNoticeHours: 0, timezone: MX }
  );

  it("toma como mucho `perDay` de cada día, en vez de los N más próximos", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 12,
      perDay: 3,
      now,
    });
    expect(spread).toHaveLength(9); // 3 días × 3
    expect(daysWithAgenda(spread)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
  });

  it("el límite corta el total sin romper el reparto", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 4,
      perDay: 3,
      now,
    });
    expect(spread).toHaveLength(4);
    // 3 del primer día + 1 del segundo: el límite no se come la variedad.
    expect(daysWithAgenda(spread)).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("cada hueco viaja con su día EN PALABRAS y su hora", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 3,
      perDay: 1,
      now,
    });
    expect(spread[0]!.dayLabel).toMatch(/^hoy /);
    expect(spread[1]!.dayLabel).toMatch(/^mañana /);
    // Lo que sale de aquí ya es texto para el prospecto: reloj de 12 h.
    expect(spread[0]!.time).toBe("9:00 am");
    expect(spread[0]!.label).toBe("mié 5 ago, 9:00 am");
  });

  it("sin huecos no inventa días", () => {
    expect(
      spreadByDay([], { timezone: MX, limit: 12, perDay: 3, now })
    ).toEqual([]);
  });
});

/**
 * Bug reportado en producción: el negocio tenía agenda miércoles, jueves,
 * viernes y lunes, pero el mensaje que Max le mandó al prospecto solo traía
 * horarios del miércoles. Causa: `offerSlots` tomaba `spread.slice(0, SHOWN)`
 * — como `spread` viene agrupado por día y el miércoles por sí solo ya tenía
 * `perDay` huecos, esos primeros SHOWN eran siempre del mismo día aunque el
 * catálogo completo (y lo que se le decía al modelo) cubriera varios más.
 */
describe("pickAcrossDays", () => {
  const now = new Date("2026-08-05T14:00:00.000Z");
  // Mié 5 a vie 7 de agosto, 09:00-18:00 ⇒ 18 huecos por día, como arriba.
  const libres = filterFreeSlots(
    buildCandidateSlots(settings(), "2026-08-05", "2026-08-07"),
    [],
    { now, minNoticeHours: 0, timezone: MX }
  );
  // El catálogo tal cual lo registra `offerSlots`: hasta 3 por día.
  const catalogo = spreadByDay(libres, {
    timezone: MX,
    limit: 12,
    perDay: 3,
    now,
  });

  it("reparte por VARIEDAD de días en vez de agotar el primero", () => {
    // El miércoles solo tiene 3 huecos en el catálogo (perDay=3), así que el
    // bug real se reproduce exacto: pedir 3 con `.slice` daría solo miércoles.
    const shown = pickAcrossDays(catalogo, 3);
    expect(shown).toHaveLength(3);
    expect(new Set(shown.map((s) => s.dayIso)).size).toBeGreaterThan(1);
    expect(daysWithAgenda(shown)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
  });

  it("con un solo día disponible, sigue devolviendo `count` huecos de ese día", () => {
    const unDia = catalogo.filter((s) => s.dayIso === "2026-08-05");
    const shown = pickAcrossDays(unDia, 3);
    expect(shown).toHaveLength(3);
    expect(daysWithAgenda(shown)).toEqual(["2026-08-05"]);
  });

  it("nunca inventa más de lo que hay", () => {
    expect(pickAcrossDays(catalogo.slice(0, 2), 5)).toHaveLength(2);
    expect(pickAcrossDays([], 5)).toEqual([]);
  });

  it("count <= 0 no devuelve nada", () => {
    expect(pickAcrossDays(catalogo, 0)).toEqual([]);
  });
});

/**
 * Incidente 2026-09-20: el agente ofreció lunes/martes/miércoles a las 09:00,
 * el cliente pidió "el miércoles pero no a las 9", y volvió a recibir los
 * MISMOS tres. `offer_slots` no tenía cómo pedir un día, y el motor no tenía
 * cómo repartir horas DENTRO de un día.
 */
describe("slotsOnDay", () => {
  it("la frontera es la hora de pared del negocio, no el prefijo del ISO", () => {
    // 19:00 en México (UTC-6) es T01:00Z del día SIGUIENTE: un
    // `startUtc.slice(0, 10)` lo asignaría al día equivocado.
    const nocturno = { startUtc: "2026-08-06T01:00:00.000Z" }; // mié 5, 19:00 MX
    const temprano = { startUtc: "2026-08-06T15:00:00.000Z" }; // jue 6, 09:00 MX
    const out = slotsOnDay([nocturno, temprano], "2026-08-05", MX);
    expect(out).toEqual([nocturno]);
  });

  it("un día sin huecos devuelve vacío en vez de fallar", () => {
    expect(slotsOnDay([{ startUtc: "2026-08-06T15:00:00.000Z" }], "2026-08-05", MX))
      .toEqual([]);
    expect(slotsOnDay([], "2026-08-05", MX)).toEqual([]);
  });
});

describe("pickWithinDay", () => {
  const now = new Date("2026-08-05T14:00:00.000Z");
  // Un día completo: 09:00-18:00 cada 30 min ⇒ 18 huecos.
  const unDia = spreadByDay(
    filterFreeSlots(
      buildCandidateSlots(settings(), "2026-08-05", "2026-08-05"),
      [],
      { now, minNoticeHours: 0, timezone: MX }
    ),
    { timezone: MX, limit: 100, perDay: 100, now }
  );

  it("reparte a lo largo de la jornada, no los tres primeros", () => {
    // El caso del incidente: alguien que dijo "por la mañana no puedo" no
    // puede recibir 09:00, 09:30 y 10:00.
    expect(unDia.length).toBeGreaterThan(10);
    const shown = pickWithinDay(unDia, 3);
    expect(shown).toHaveLength(3);
    expect(new Set(shown.map((s) => s.dayIso)).size).toBe(1);
    expect(new Set(shown.map((s) => s.time)).size).toBe(3);
    // El primero es el más temprano y el último, el más tardío del día.
    expect(shown[0]!.time).toBe(unDia[0]!.time);
    expect(shown[2]!.time).toBe(unDia[unDia.length - 1]!.time);
    // Y hay algo después del mediodía, que es lo que el cliente pedía.
    expect(shown.some((s) => s.time.endsWith("pm"))).toBe(true);
  });

  it("con menos huecos que `count`, los devuelve todos sin inventar", () => {
    expect(pickWithinDay(unDia.slice(0, 2), 3)).toHaveLength(2);
    expect(pickWithinDay([], 3)).toEqual([]);
  });

  it("count <= 0 no devuelve nada", () => {
    expect(pickWithinDay(unDia, 0)).toEqual([]);
  });
});

describe("normalizeWeeklyHours", () => {
  it("descarta intervalos inválidos sin tumbar el resto del horario", () => {
    const out = normalizeWeeklyHours({
      mon: [
        { start: "09:00", end: "18:00" },
        { start: "20:00", end: "19:00" }, // fin antes del inicio
        { start: "9:00", end: "18:00" }, // formato inválido
      ],
      tue: [],
    });
    expect(out.mon).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(out.tue).toBeUndefined(); // día sin franjas válidas = cerrado
  });

  it("ordena las franjas por hora de inicio", () => {
    const out = normalizeWeeklyHours({
      wed: [
        { start: "16:00", end: "18:00" },
        { start: "09:00", end: "13:00" },
      ],
    });
    expect(out.wed?.[0]?.start).toBe("09:00");
  });
});
