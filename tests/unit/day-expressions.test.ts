import { describe, expect, it } from "vitest";
import {
  minutesOfDay,
  normalizeExpression,
  parseTimeReading,
  parseWeekQualifier,
  resolveDayExpression,
  weekdayDatesThisAndNextWeek,
  weekdayIndexOf,
  withinIntervals,
} from "@/lib/time/day-expressions";

/**
 * Spec 025 §3 — el servidor interpreta las palabras del prospecto. «Hoy» es el
 * jueves 2026-09-17 (ya en la zona del negocio).
 */

const TODAY = "2026-09-17"; // jueves
const OFFICE = [{ start: "09:00", end: "18:00" }];
const SPLIT = [
  { start: "09:00", end: "13:00" },
  { start: "15:00", end: "19:00" },
];

const day = (raw: string, today = TODAY) => {
  const r = resolveDayExpression(raw, today);
  return r.ok ? r.dayIso : null;
};

describe("resolveDayExpression", () => {
  it("sabe qué día de la semana es hoy (base de las pruebas)", () => {
    expect(weekdayIndexOf(TODAY)).toBe(4); // jueves
  });

  it.each([
    ["hoy", "2026-09-17"],
    ["Hoy", "2026-09-17"],
    ["mañana", "2026-09-18"],
    ["Mañana", "2026-09-18"],
    ["manana", "2026-09-18"],
    ["pasado mañana", "2026-09-19"],
    ["tomorrow", "2026-09-18"],
    ["2026-09-21", "2026-09-21"],
  ])("«%s» → %s", (raw, expected) => {
    expect(day(raw)).toBe(expected);
  });

  it.each([
    ["lunes", "2026-09-21"],
    ["el lunes", "2026-09-21"],
    ["próximo lunes", "2026-09-21"],
    ["el próximo lunes", "2026-09-21"],
    ["lunes que viene", "2026-09-21"],
    ["martes", "2026-09-22"],
    ["miércoles", "2026-09-23"],
    ["viernes", "2026-09-18"],
    // «viernes que viene» discrimina de "de la próxima semana" (regla 1, no regla 4): si "que
    // viene" se tratara como calificador de SEMANA SIGUIENTE por error, esto daría 2026-09-25.
    ["viernes que viene", "2026-09-18"],
    ["sábado", "2026-09-19"],
    ["domingo", "2026-09-20"],
    ["monday", "2026-09-21"],
  ])("el día de la semana «%s» es el PRÓXIMO (%s) — reglas 1, 2, 6", (raw, expected) => {
    expect(day(raw)).toBe(expected);
  });

  it("«jueves» dicho un jueves es el de la semana SIGUIENTE, nunca hoy (regla 3)", () => {
    expect(day("jueves")).toBe("2026-09-24");
    expect(day("el jueves")).toBe("2026-09-24");
    expect(day("jueves que viene")).toBe("2026-09-24");
    expect(day("el próximo jueves")).toBe("2026-09-24");
  });

  /* 026 — «este <día>»: la semana calendario ACTUAL, puede ser hoy; si ya
   * pasó, NO se reinterpreta en silencio (regla 5). TODAY = jueves 2026-09-17. */
  describe("«este <día>» — semana ACTUAL (regla 5, distinto de «el próximo»/bare)", () => {
    it("«este jueves» dicho un jueves ES hoy", () => {
      expect(day("este jueves")).toBe("2026-09-17");
      expect(day("esta jueves")).toBe("2026-09-17"); // tolera el género
    });

    it("un día de esta semana que TODAVÍA no llega: se resuelve normal", () => {
      expect(day("este viernes")).toBe("2026-09-18"); // mañana, dentro de esta semana
      expect(day("este sábado")).toBe("2026-09-19");
      expect(day("este domingo")).toBe("2026-09-20");
    });

    it("un día de esta semana que YA PASÓ: no se convierte en la próxima semana — se rechaza con la razón", () => {
      expect(resolveDayExpression("este lunes", TODAY)).toEqual({
        ok: false,
        reason: "already_passed_this_week",
      });
      expect(resolveDayExpression("este martes", TODAY)).toEqual({
        ok: false,
        reason: "already_passed_this_week",
      });
      expect(resolveDayExpression("este miércoles", TODAY)).toEqual({
        ok: false,
        reason: "already_passed_this_week",
      });
    });

    it("dicho un LUNES (inicio de semana), «este lunes» también es hoy", () => {
      expect(day("este lunes", "2026-09-21")).toBe("2026-09-21");
    });

    it("dicho un DOMINGO (fin de semana), el lunes de esta semana ya pasó", () => {
      expect(resolveDayExpression("este lunes", "2026-09-20")).toEqual({
        ok: false,
        reason: "already_passed_this_week",
      });
      expect(day("este domingo", "2026-09-20")).toBe("2026-09-20"); // hoy mismo
    });
  });

  /* 026 — «<día> de la próxima semana»: SIEMPRE la semana calendario
   * siguiente, exista o no ya haya pasado el día de esta semana (regla 4). */
  describe("«<día> de la próxima semana» — SIEMPRE la semana siguiente (regla 4)", () => {
    it.each([
      ["jueves de la próxima semana", "2026-09-24"], // hoy es jueves → +7 (igual que bare, coincide)
      ["domingo de la próxima semana", "2026-09-27"], // bare "domingo" sería el 20 (esta semana): distinto
      ["viernes de la semana que viene", "2026-09-25"], // bare "viernes" sería mañana (18): distinto
      ["martes de la semana entrante", "2026-09-22"],
      ["miércoles de la otra semana", "2026-09-23"],
    ])("«%s» → %s", (raw, expected) => {
      expect(day(raw)).toBe(expected);
    });

    it("dicho un LUNES: «jueves de la próxima semana» es una semana completa después del jueves más cercano", () => {
      // El próximo jueves (bare) desde el lunes 21 es el 24; "de la próxima semana" salta a Oct 1.
      expect(day("jueves", "2026-09-21")).toBe("2026-09-24");
      expect(day("jueves de la próxima semana", "2026-09-21")).toBe("2026-10-01");
    });
  });

  describe("parseWeekQualifier", () => {
    it("separa el calificador del resto", () => {
      expect(parseWeekQualifier("jueves de la próxima semana")).toEqual({ qualifier: "next", rest: "jueves" });
      expect(parseWeekQualifier("este jueves")).toEqual({ qualifier: "same", rest: "jueves" });
      expect(parseWeekQualifier("jueves que viene")).toEqual({ qualifier: "none", rest: "jueves" });
      expect(parseWeekQualifier("jueves")).toEqual({ qualifier: "none", rest: "jueves" });
      expect(parseWeekQualifier("25 de septiembre")).toEqual({ qualifier: "none", rest: "25 de septiembre" });
    });
  });

  describe("weekdayDatesThisAndNextWeek", () => {
    it("da ambas fechas aunque la de esta semana ya haya pasado", () => {
      expect(weekdayDatesThisAndNextWeek("lunes", TODAY)).toEqual({ same: "2026-09-14", next: "2026-09-21" });
      expect(weekdayDatesThisAndNextWeek("jueves", TODAY)).toEqual({ same: "2026-09-17", next: "2026-09-24" });
    });

    it("null si no es un día de semana reconocible", () => {
      expect(weekdayDatesThisAndNextWeek("mañana", TODAY)).toBeNull();
      expect(weekdayDatesThisAndNextWeek("no sé", TODAY)).toBeNull();
    });
  });

  it.each([
    ["25 de septiembre", "2026-09-25"],
    ["25 sep", "2026-09-25"],
    ["25 septiembre", "2026-09-25"],
    ["25/09", "2026-09-25"],
    ["25-09", "2026-09-25"],
    ["25 de septiembre de 2027", "2027-09-25"],
    ["1 de octubre", "2026-10-01"],
    ["1 oct", "2026-10-01"],
  ])("fecha «%s» → %s", (raw, expected) => {
    expect(day(raw)).toBe(expected);
  });

  it("una fecha sin año que ya pasó este año se entiende del año siguiente", () => {
    expect(day("10 de septiembre")).toBe("2027-09-10");
    expect(day("1 de enero")).toBe("2027-01-01");
  });

  it("cruza el fin de año y respeta el mes real", () => {
    expect(day("mañana", "2026-12-31")).toBe("2027-01-01");
    expect(day("lunes", "2026-12-31")).toBe("2027-01-04");
    expect(day("29 de febrero de 2026", "2026-01-10")).toBeNull(); // 2026 no es bisiesto
    expect(day("29 de febrero", "2026-01-10")).toBe("2028-02-29"); // sin año: el siguiente bisiesto
    expect(day("29 de febrero", "2027-12-01")).toBe("2028-02-29");
    expect(day("31 de abril")).toBeNull();
  });

  it.each(["", "   ", "la semana que viene", "a fin de mes", "cuando puedas", "2026-13-40", "25 de smarch", "lunes 21"])(
    "no inventa: «%s» no se reconoce (se pregunta)",
    (raw) => {
      expect(day(raw)).toBeNull();
    }
  );

  it("normaliza acentos, mayúsculas y signos", () => {
    expect(normalizeExpression("¿El MIÉRCOLES?")).toBe("miercoles");
    expect(normalizeExpression("  para el   viernes ")).toBe("viernes");
  });
});

describe("parseTimeReading — con el horario del día como árbitro", () => {
  const t = (raw: string, intervals = OFFICE) => parseTimeReading(raw, intervals);

  it("hora sin marca: se queda con la lectura que cae dentro del horario", () => {
    expect(t("11")).toEqual({ candidates: ["11:00"], ambiguous: false }); // 23:00 no
    expect(t("12")).toEqual({ candidates: ["12:00"], ambiguous: false });
    expect(t("4")).toEqual({ candidates: ["16:00"], ambiguous: false }); // 04:00 no
    expect(t("5")).toEqual({ candidates: ["17:00"], ambiguous: false });
    expect(t("9")).toEqual({ candidates: ["09:00"], ambiguous: false });
    expect(t("4:30")).toEqual({ candidates: ["16:30"], ambiguous: false });
  });

  it("marca explícita manda sobre el horario", () => {
    expect(t("4 de la tarde")?.candidates).toEqual(["16:00"]);
    expect(t("4 pm")?.candidates).toEqual(["16:00"]);
    expect(t("4 p.m.")?.candidates).toEqual(["16:00"]);
    expect(t("5 de la tarde")?.candidates).toEqual(["17:00"]);
    expect(t("9 de la mañana")?.candidates).toEqual(["09:00"]);
    expect(t("9 am")?.candidates).toEqual(["09:00"]);
    expect(t("8 de la noche")?.candidates).toEqual(["20:00"]);
    expect(t("12 pm")?.candidates).toEqual(["12:00"]);
    expect(t("12 am")?.candidates).toEqual(["00:00"]);
  });

  it("24 horas, mediodía y minutos", () => {
    expect(t("16:00")?.candidates).toEqual(["16:00"]);
    expect(t("17:30")?.candidates).toEqual(["17:30"]);
    expect(t("13")?.candidates).toEqual(["13:00"]);
    expect(t("mediodía")?.candidates).toEqual(["12:00"]);
    expect(t("a las 11:30")?.candidates).toEqual(["11:30"]);
    expect(t("las 4 y media")?.candidates).toEqual(["16:30"]); // «y media» se lee, no se ignora
    expect(t("4 y cuarto")?.candidates).toEqual(["16:15"]);
    expect(t("4 menos cuarto")?.candidates).toEqual(["15:45"]);
  });

  it("hora ambigua de verdad: si ambas lecturas caen en horario, devuelve las dos", () => {
    const wide = [{ start: "06:00", end: "23:00" }];
    expect(t("9", wide)).toEqual({ candidates: ["09:00", "21:00"], ambiguous: true });
    // con marca deja de ser ambigua
    expect(t("9 de la noche", wide)).toEqual({ candidates: ["21:00"], ambiguous: false });
  });

  it("ninguna lectura cae en horario: conserva la verosímil para poder decir «fuera de horario»", () => {
    expect(t("8")?.candidates).toEqual(["08:00"]); // 20:00 tampoco cabe; 8 → mañana
    expect(t("2", SPLIT)?.candidates).toEqual(["14:00"]); // 14:00 cae en el hueco del mediodía
    expect(t("3", [{ start: "09:00", end: "12:00" }])?.candidates).toEqual(["15:00"]);
  });

  it("con horario partido decide por el tramo correcto", () => {
    expect(t("4", SPLIT)?.candidates).toEqual(["16:00"]);
    expect(t("10", SPLIT)?.candidates).toEqual(["10:00"]);
  });

  it.each(["", "por la tarde", "pronto", "25:00", "10:75"])("«%s» no es una hora", (raw) => {
    expect(t(raw)).toBeNull();
  });

  it("utilidades", () => {
    expect(minutesOfDay("16:30")).toBe(990);
    expect(withinIntervals("09:00", OFFICE)).toBe(true);
    expect(withinIntervals("18:00", OFFICE)).toBe(false); // el fin no cuenta como inicio
    expect(withinIntervals("13:30", SPLIT)).toBe(false);
  });
});
