import { describe, expect, it } from "vitest";
import {
  dayLabelInTz,
  eachDateInRange,
  expandWorkingDayToUtc,
  hhmmTo12h,
  isValidTimeZone,
  labelInTz,
  overlaps,
  partsInTz,
  timeInTz,
  timezoneLabel,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
} from "@/lib/time/slots";

/**
 * 015 — Los bordes que rompen un motor de agenda: DST, franjas partidas y
 * días cerrados. Sin luxon: si `Intl` fallara, estos tests lo gritan.
 */

const MX = "America/Mexico_City";
const NY = "America/New_York";
const MADRID = "Europe/Madrid";

describe("zonedWallClockToUtc — hora de pared → instante", () => {
  it("México no tiene DST desde 2022: 09:00 son las 15:00Z todo el año", () => {
    expect(zonedWallClockToUtc("2026-08-05", "09:00", MX)?.toISOString()).toBe(
      "2026-08-05T15:00:00.000Z"
    );
    expect(zonedWallClockToUtc("2026-01-14", "09:00", MX)?.toISOString()).toBe(
      "2026-01-14T15:00:00.000Z"
    );
  });

  it("Nueva York: la misma hora local cambia de instante al entrar el DST", () => {
    // El DST arranca el 2026-03-08.
    expect(zonedWallClockToUtc("2026-03-07", "09:00", NY)?.toISOString()).toBe(
      "2026-03-07T14:00:00.000Z"
    );
    expect(zonedWallClockToUtc("2026-03-09", "09:00", NY)?.toISOString()).toBe(
      "2026-03-09T13:00:00.000Z"
    );
  });

  it("Madrid: idem en el cambio europeo (2026-03-29)", () => {
    expect(
      zonedWallClockToUtc("2026-03-28", "09:00", MADRID)?.toISOString()
    ).toBe("2026-03-28T08:00:00.000Z");
    expect(
      zonedWallClockToUtc("2026-03-30", "09:00", MADRID)?.toISOString()
    ).toBe("2026-03-30T07:00:00.000Z");
  });

  it("una hora inexistente (salto de primavera) devuelve un instante real, no lanza", () => {
    // 02:30 del 2026-03-08 en NY no existe: el reloj salta de 02:00 a 03:00.
    const d = zonedWallClockToUtc("2026-03-08", "02:30", NY);
    expect(d).not.toBeNull();
    expect(Number.isNaN(d!.getTime())).toBe(false);
  });

  it("rechaza formatos inválidos en vez de inventar una fecha", () => {
    expect(zonedWallClockToUtc("2026-8-5", "09:00", MX)).toBeNull();
    expect(zonedWallClockToUtc("2026-08-05", "9:00", MX)).toBeNull();
    expect(zonedWallClockToUtc("2026-08-05", "25:00", MX)).toBeNull();
  });
});

describe("weekdayKeyOf / todayInTz", () => {
  it("da el día de la semana en la zona del negocio", () => {
    expect(weekdayKeyOf("2026-08-05", MX)).toBe("wed");
    expect(weekdayKeyOf("2026-03-29", MADRID)).toBe("sun");
  });

  it("el día 'de hoy' depende de la zona, no del servidor", () => {
    // 03:00Z del 6 de agosto sigue siendo 5 de agosto en México (UTC-6).
    const instant = new Date("2026-08-06T03:00:00.000Z");
    expect(todayInTz(instant, MX)).toBe("2026-08-05");
    expect(todayInTz(instant, MADRID)).toBe("2026-08-06");
  });
});

describe("expandWorkingDayToUtc", () => {
  it("genera slots de la duración pedida dentro de la franja", () => {
    const slots = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "11:00" }],
      MX,
      30,
      0
    );
    expect(slots).toHaveLength(4);
    expect(slots[0]!.startUtc).toBe("2026-08-05T15:00:00.000Z");
    expect(slots[0]!.endUtc).toBe("2026-08-05T15:30:00.000Z");
    expect(slots[3]!.startUtc).toBe("2026-08-05T16:30:00.000Z");
  });

  it("el respiro separa los slots sin desbordar la franja", () => {
    const slots = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "11:00" }],
      MX,
      30,
      15
    );
    // 09:00, 09:45, 10:30 (10:30+30 = 11:00, cabe justo)
    expect(slots.map((s) => s.startUtc)).toEqual([
      "2026-08-05T15:00:00.000Z",
      "2026-08-05T15:45:00.000Z",
      "2026-08-05T16:30:00.000Z",
    ]);
  });

  it("una franja partida no genera nada en el hueco del medio", () => {
    const slots = expandWorkingDayToUtc(
      "2026-08-05",
      [
        { start: "09:00", end: "13:00" },
        { start: "16:00", end: "18:00" },
      ],
      MX,
      60,
      0
    );
    const horas = slots.map((s) => s.startUtc.slice(11, 16));
    expect(horas).toEqual([
      "15:00",
      "16:00",
      "17:00",
      "18:00",
      "22:00",
      "23:00",
    ]);
  });

  it("un día sin franjas (cerrado) no genera slots", () => {
    expect(expandWorkingDayToUtc("2026-08-09", [], MX, 30, 0)).toEqual([]);
  });

  it("no emite un slot que no cabe completo en la franja", () => {
    const slots = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "09:45" }],
      MX,
      30,
      0
    );
    expect(slots).toHaveLength(1);
  });
});

describe("eachDateInRange", () => {
  it("incluye ambos extremos", () => {
    expect(eachDateInRange("2026-08-03", "2026-08-06")).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
    ]);
  });

  it("rango invertido → vacío (no cuelga)", () => {
    expect(eachDateInRange("2026-08-06", "2026-08-03")).toEqual([]);
  });
});

describe("overlaps", () => {
  const a = ["2026-08-05T15:00:00.000Z", "2026-08-05T15:30:00.000Z"] as const;

  it("solape parcial cuenta como ocupado", () => {
    expect(
      overlaps(
        a[0],
        a[1],
        "2026-08-05T15:15:00.000Z",
        "2026-08-05T15:45:00.000Z"
      )
    ).toBe(true);
  });

  it("intervalos contiguos NO se solapan", () => {
    expect(
      overlaps(
        a[0],
        a[1],
        "2026-08-05T15:30:00.000Z",
        "2026-08-05T16:00:00.000Z"
      )
    ).toBe(false);
  });
});

describe("etiquetas para el cliente", () => {
  it("labelInTz muestra la hora local del negocio", () => {
    const label = labelInTz("2026-08-05T15:00:00.000Z", MX);
    expect(label).toContain("09:00");
    expect(label).toContain("5");
    // Mismo instante, otra zona ⇒ otra hora.
    expect(labelInTz("2026-08-05T15:00:00.000Z", MADRID)).toContain("17:00");
  });

  it("partsInTz separa fecha, hora y día", () => {
    const parts = partsInTz("2026-08-05T15:00:00.000Z", MX);
    expect(parts.time).toBe("09:00");
    expect(parts.date).toContain("2026");
    expect(parts.weekday.length).toBeGreaterThan(0);
  });

  it("timeInTz da solo la hora local", () => {
    expect(timeInTz("2026-08-05T15:00:00.000Z", MX)).toBe("09:00");
  });

  it("un instante inválido degrada a vacío en vez de lanzar", () => {
    expect(labelInTz("no-es-fecha", MX)).toBe("");
    expect(timeInTz("no-es-fecha", MX)).toBe("");
    expect(dayLabelInTz("no-es-fecha", MX)).toBe("");
    expect(partsInTz("no-es-fecha", MX).time).toBe("");
    expect(labelInTz("no-es-fecha", MX, { hour12: true })).toBe("");
    expect(timeInTz("no-es-fecha", MX, { hour12: true })).toBe("");
  });
});

/**
 * El prospecto lee "9:00 am", no "09:00". El reloj de 24 h se queda para el
 * panel del operador, así que el 12 h es EXPLÍCITO: nadie lo hereda sin
 * pedirlo.
 *
 * Se arma a mano (hora 0-23 → am/pm) en vez de leer el `dayPeriod` del locale
 * porque `es-MX` devuelve "a. m." con espacio duro y el ICU del contenedor
 * Alpine ha variado entre versiones. Estos casos son ese contrato.
 */
describe("reloj de 12 horas — lo que ve el prospecto", () => {
  it("sin opciones nada cambia: el panel sigue en 24 h", () => {
    expect(timeInTz("2026-08-05T15:00:00.000Z", MX)).toBe("09:00");
    expect(labelInTz("2026-08-05T15:00:00.000Z", MX)).toBe("mié 5 ago, 09:00");
    expect(partsInTz("2026-08-05T15:00:00.000Z", MX).time).toBe("09:00");
  });

  it("minúsculas, sin puntos y sin cero a la izquierda", () => {
    const opts = { hour12: true };
    expect(timeInTz("2026-08-05T15:00:00.000Z", MX, opts)).toBe("9:00 am");
    expect(labelInTz("2026-08-05T15:00:00.000Z", MX, opts)).toBe(
      "mié 5 ago, 9:00 am"
    );
    expect(partsInTz("2026-08-05T15:00:00.000Z", MX, opts).time).toBe("9:00 am");
    // Los minutos SÍ llevan su cero: "9:05 am", nunca "9:5 am".
    expect(timeInTz("2026-08-05T15:05:00.000Z", MX, opts)).toBe("9:05 am");
  });

  it("mediodía es 12:00 pm y medianoche 12:00 am, no 0:00", () => {
    const opts = { hour12: true };
    // 18:00Z = 12:00 en México (UTC-6).
    expect(timeInTz("2026-08-05T18:00:00.000Z", MX, opts)).toBe("12:00 pm");
    // 06:00Z = 00:00 en México.
    expect(timeInTz("2026-08-05T06:00:00.000Z", MX, opts)).toBe("12:00 am");
    // Y la tarde no se queda en 24 h.
    expect(timeInTz("2026-08-05T23:30:00.000Z", MX, opts)).toBe("5:30 pm");
  });

  it("respeta la zona del negocio, no la del servidor", () => {
    // Mismo instante: 09:00 en México, 17:00 en Madrid.
    expect(timeInTz("2026-08-05T15:00:00.000Z", MADRID, { hour12: true })).toBe(
      "5:00 pm"
    );
  });

  it("hhmmTo12h traduce horas de pared, no instantes", () => {
    expect(hhmmTo12h("09:00")).toBe("9:00 am");
    expect(hhmmTo12h("18:00")).toBe("6:00 pm");
    expect(hhmmTo12h("12:30")).toBe("12:30 pm");
    expect(hhmmTo12h("00:00")).toBe("12:00 am");
    // Basura entra, basura sale — pero sin lanzar ni inventar una hora.
    expect(hhmmTo12h("25:00")).toBe("25:00");
    expect(hhmmTo12h("")).toBe("");
  });
});

/**
 * El día en palabras es lo que evita el fallo caro: un lead contestó
 * "10:30, de mañana" a una oferta de HOY y se agendó el día equivocado.
 */
describe("dayLabelInTz — el día EN PALABRAS", () => {
  const now = new Date("2026-08-05T15:00:00.000Z"); // miércoles 5, 09:00 en MX

  it("marca 'hoy' cuando el slot cae en el día en curso del negocio", () => {
    const label = dayLabelInTz("2026-08-05T20:00:00.000Z", MX, now);
    expect(label).toMatch(/^hoy /);
    expect(label).toContain("miércoles");
    expect(label).toContain("5");
    expect(label).toContain("agosto");
  });

  it("marca 'mañana' en el día siguiente", () => {
    const label = dayLabelInTz("2026-08-06T16:00:00.000Z", MX, now);
    expect(label).toMatch(/^mañana /);
    expect(label).toContain("jueves");
  });

  it("un día más lejano va sin prefijo, pero SIEMPRE con el día nombrado", () => {
    const label = dayLabelInTz("2026-08-10T16:00:00.000Z", MX, now);
    expect(label).not.toMatch(/^(hoy|mañana) /);
    expect(label).toContain("lunes");
    expect(label).toContain("10");
  });

  it("'hoy' se decide en la zona del negocio, no en la del servidor", () => {
    // 03:00Z del 6 sigue siendo 5 de agosto en México.
    const instant = "2026-08-06T03:00:00.000Z";
    expect(dayLabelInTz(instant, MX, now)).toMatch(/^hoy /);
    expect(dayLabelInTz(instant, MADRID, now)).toMatch(/^mañana /);
  });
});

describe("isValidTimeZone", () => {
  it("acepta zonas IANA reales y rechaza inventadas", () => {
    expect(isValidTimeZone(MX)).toBe(true);
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("Marte/Olympus")).toBe(false);
  });
});

describe("timezoneLabel", () => {
  it("incluye el nombre IANA y el offset vigente en ese instante", () => {
    // Agosto: México sin horario de verano desde 2022 ⇒ GMT-6 todo el año.
    expect(timezoneLabel(MX, new Date("2026-08-05T15:00:00.000Z"))).toBe(
      "America/Mexico_City (GMT-6)"
    );
  });

  it("respeta el horario de verano vigente en el instante dado", () => {
    // Nueva York: GMT-4 en agosto (verano), GMT-5 en enero (invierno).
    expect(timezoneLabel(NY, new Date("2026-08-05T15:00:00.000Z"))).toBe(
      "America/New_York (GMT-4)"
    );
    expect(timezoneLabel(NY, new Date("2026-01-05T15:00:00.000Z"))).toBe(
      "America/New_York (GMT-5)"
    );
  });

  it("formatea minutos de offset distintos de :00", () => {
    // India: GMT+5:30 todo el año.
    expect(
      timezoneLabel("Asia/Kolkata", new Date("2026-08-05T15:00:00.000Z"))
    ).toBe("Asia/Kolkata (GMT+5:30)");
  });
});
