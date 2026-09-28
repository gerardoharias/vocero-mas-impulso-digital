import { describe, expect, it } from "vitest";
import {
  explicitEdge,
  extractTemporalQuery,
  guardAgendaAction,
  normalizeAgentActionInput,
  normalizeQueryFields,
} from "@/server/agenda/query-intent";

/**
 * Spec 025 (revisión correctiva) — la frontera entre lo que el modelo dice y lo
 * que el cliente pidió. Cubre los tres fallos de la prueba real con el perfil de
 * producción: `edge:"earliest"` indebido, cadenas vacías, y `offer_slots` ante una
 * expresión temporal.
 */

describe("normalizeQueryFields — vacío es AUSENCIA", () => {
  it.each([
    ["cadena vacía", { day: "", from: "", to: "" }],
    ["sólo espacios", { day: "   ", from: "\t", to: " \n " }],
    ["null", { day: null, times: null, from: null, to: null, edge: null }],
    ["arreglo vacío", { times: [] }],
    ["arreglo de vacíos", { times: ["", "  ", "\n"] }],
    ["edge vacío", { edge: "" }],
    ["edge inválido", { edge: "asc" }],
    ["tipos que no son texto", { day: {}, times: [{}], from: [], to: true }],
  ])("%s → {}", (_n, raw) => {
    expect(normalizeQueryFields(raw as Record<string, unknown>)).toEqual({});
  });

  it("conserva (recortado) lo que sí trae contenido y descarta sólo lo vacío", () => {
    expect(
      normalizeQueryFields({ day: "  el lunes ", times: ["11", "", " 12 "], from: "", to: "  ", edge: " LATEST " })
    ).toEqual({ day: "el lunes", times: ["11", "12"], edge: "latest" });
  });

  it("un texto suelto en `times` es una lista de uno; un número es su texto", () => {
    expect(normalizeQueryFields({ times: "4 de la tarde" })).toEqual({ times: ["4 de la tarde"] });
    expect(normalizeQueryFields({ times: [11, 12] })).toEqual({ times: ["11", "12"] });
  });

  it("es idempotente", () => {
    const once = normalizeQueryFields({ day: " mañana ", times: [" ", "5"], from: "", edge: "latest" });
    expect(normalizeQueryFields(once)).toEqual(once);
  });
});

describe("normalizeQueryFields — 026: `days` (días alternativos)", () => {
  it("un texto suelto o números en `days` se normalizan igual que `times`", () => {
    expect(normalizeQueryFields({ days: "jueves" })).toEqual({ days: ["jueves"] });
    expect(normalizeQueryFields({ days: ["jueves", "", " viernes ", "  "] })).toEqual({
      days: ["jueves", "viernes"],
    });
  });

  it("`days` vacío es AUSENCIA, igual que `day`", () => {
    expect(normalizeQueryFields({ days: [] })).toEqual({});
    expect(normalizeQueryFields({ days: ["", "  "] })).toEqual({});
    expect(normalizeQueryFields({ days: null })).toEqual({});
  });

  it("`day` y `days` son mutuamente excluyentes: `days` gana si viene con contenido", () => {
    expect(normalizeQueryFields({ day: "lunes", days: ["jueves", "viernes"] })).toEqual({
      days: ["jueves", "viernes"],
    });
    // `days` vacío no gana: `day` sobrevive.
    expect(normalizeQueryFields({ day: "lunes", days: [] })).toEqual({ day: "lunes" });
  });

  it("tope defensivo: nunca deja pasar una lista descomunal", () => {
    const huge = Array.from({ length: 50 }, (_, i) => `dia${i}`);
    expect(normalizeQueryFields({ days: huge }).days).toHaveLength(10);
  });
});

describe("normalizeAgentActionInput — sólo toca check_availability", () => {
  it("el sobre ruidoso de un modelo pequeño en modo estricto queda limpio", () => {
    expect(
      normalizeAgentActionInput({ action: "check_availability", day: "mañana", times: [], from: "", to: "", edge: "" })
    ).toEqual({ action: "check_availability", day: "mañana" });
  });

  it("descarta campos ajenos a la acción", () => {
    expect(
      normalizeAgentActionInput({ action: "check_availability", day: "lunes", reply: "hola", text: "x" })
    ).toEqual({ action: "check_availability", day: "lunes" });
  });

  it.each([
    { action: "reply", text: "" },
    { action: "offer_slots", reply: "" },
    { action: "book_slot", startUtc: "2026-09-21T15:00:00.000Z" },
    { action: "none" },
  ])("no toca %j", (raw) => {
    expect(normalizeAgentActionInput(raw)).toBe(raw);
  });

  it("deja pasar lo que no es un objeto (Zod lo rechazará)", () => {
    expect(normalizeAgentActionInput("texto")).toBe("texto");
    expect(normalizeAgentActionInput(null)).toBeNull();
    expect(normalizeAgentActionInput([1])).toEqual([1]);
  });
});

describe("explicitEdge — sólo con las palabras del cliente", () => {
  it.each([
    ["¿Cuál es el horario más tarde del lunes?", "latest"],
    ["dame el último horario", "latest"],
    ["¿cuál es el último?", "latest"],
    ["lo más tarde posible", "latest"],
    ["¿Cuál es el horario más temprano?", "earliest"],
    ["quiero el primer horario", "earliest"],
    ["el primero que tengas", "earliest"],
    ["lo antes posible", "earliest"],
    ["lo más pronto que puedas", "earliest"],
  ])("«%s» → %s", (text, edge) => {
    expect(explicitEdge(text)).toBe(edge);
  });

  it.each([
    "¿Tienes más horarios mañana?",
    "¿Qué horarios tienes?",
    "¿Tienes disponibilidad mañana?",
    "¿Tienes disponibilidad la semana que viene?",
    "¿Puedes el lunes a las 11 o 12?",
    "por la tarde",
    "más opciones por favor",
    "el primero de octubre",
    "el último de septiembre",
    "",
  ])("«%s» NO es un extremo", (text) => {
    expect(explicitEdge(text)).toBeNull();
  });

  it("si pide los dos extremos a la vez, no hay extremo (ambiguo)", () => {
    expect(explicitEdge("el más temprano o el más tarde")).toBeNull();
  });
});

describe("extractTemporalQuery — lo temporal, con las palabras del cliente", () => {
  it("«la semana que viene» viaja tal cual (el servidor pedirá la aclaración)", () => {
    expect(extractTemporalQuery("¿Tienes disponibilidad la semana que viene?")).toEqual({
      hasTemporal: true,
      day: "la semana que viene",
    });
  });

  it("«más horarios mañana» es un día, NUNCA un extremo", () => {
    const q = extractTemporalQuery("¿Tienes más horarios mañana?");
    expect(q).toEqual({ hasTemporal: true, day: "mañana" });
    expect(q.edge).toBeUndefined();
  });

  it("día + dos horas", () => {
    expect(extractTemporalQuery("¿Puedes el lunes a las 11 o 12?")).toEqual({
      hasTemporal: true,
      day: "el lunes",
      times: ["11", "12"],
    });
  });

  it("el sufijo compartido se aplica a las dos horas", () => {
    expect(extractTemporalQuery("¿Tienes el lunes a las 4 o 5 de la tarde?")).toEqual({
      hasTemporal: true,
      day: "el lunes",
      times: ["4 de la tarde", "5 de la tarde"],
    });
  });

  it("«y media», «y cuarto» y «menos cuarto» viajan con la hora", () => {
    expect(extractTemporalQuery("el martes a las 4 y media").times).toEqual(["4 y media"]);
    expect(extractTemporalQuery("el martes a las 5 menos cuarto").times).toEqual(["5 menos cuarto"]);
  });

  it("extremo + día", () => {
    expect(extractTemporalQuery("¿Cuál es el horario más tarde del lunes?")).toEqual({
      hasTemporal: true,
      day: "lunes",
      edge: "latest",
    });
  });

  it("rangos", () => {
    expect(extractTemporalQuery("el jueves entre las 2 y las 4 de la tarde")).toMatchObject({
      day: "el jueves",
      from: "2",
      to: "4 de la tarde",
    });
    expect(extractTemporalQuery("mañana después de las 3 pm")).toMatchObject({ day: "mañana", from: "3 pm" });
    expect(extractTemporalQuery("mañana antes de las 12")).toMatchObject({ to: "12" });
  });

  it.each([
    ["el 25 de septiembre", "el 25 de septiembre"],
    ["2026-09-25", "2026-09-25"],
    ["pasado mañana", "pasado mañana"],
    ["hoy mismo", "hoy"],
    ["el próximo mes", "el próximo mes"],
    ["este fin de semana", "este fin de semana"],
    ["la próxima semana", "la próxima semana"],
    ["en dos semanas", "en dos semanas"],
  ])("día/periodo «%s»", (text, day) => {
    expect(extractTemporalQuery(text)).toMatchObject({ hasTemporal: true, day });
  });

  it("horas sueltas: «4pm», «al mediodía»", () => {
    expect(extractTemporalQuery("puedo a las 4pm").times?.length).toBeGreaterThan(0);
    expect(extractTemporalQuery("¿Tienen algo al mediodía?").times).toEqual(["mediodía"]);
  });

  it.each([
    "Hola, ¿qué hace Vocero?",
    "quiero agendar una llamada",
    "¿Qué horarios tienes?",
    "por la mañana me va mejor",
    "en la mañana estoy libre",
    "mi negocio tiene 3 años",
    "somos 12 personas en el equipo",
    "vendo 100 productos al mes",
    "",
  ])("«%s» no es una expresión temporal", (text) => {
    expect(extractTemporalQuery(text).hasTemporal).toBe(false);
  });

  it("«mañana por la mañana»: el día es «mañana»; la parte del día no se toma por otro día", () => {
    expect(extractTemporalQuery("mañana por la mañana").day).toBe("mañana");
  });
});

describe("guardAgendaAction — la compuerta previa a ejecutar", () => {
  it("FALLO 1: `edge:\"earliest\"` indebido en «¿Tienes más horarios mañana?» se quita → el día completo", () => {
    const g = guardAgendaAction(
      { action: "check_availability", day: "mañana", edge: "earliest" as const },
      "¿Tienes más horarios mañana?"
    );
    expect(g.action).toEqual({ action: "check_availability", day: "mañana" });
    expect(g.changes).toContain("edge_removed");
  });

  it.each([
    "¿Qué horarios hay mañana?",
    "¿Tienes disponibilidad mañana?",
    "más horarios mañana por favor",
  ])("«%s» nunca conserva un `edge`", (text) => {
    for (const edge of ["earliest", "latest"] as const) {
      const g = guardAgendaAction({ action: "check_availability", day: "mañana", edge }, text);
      expect((g.action as { edge?: string }).edge).toBeUndefined();
    }
  });

  it("un `edge` que el cliente sí pidió se conserva", () => {
    const g = guardAgendaAction(
      { action: "check_availability", day: "lunes", edge: "latest" as const },
      "¿Cuál es el horario más tarde del lunes?"
    );
    expect(g.action).toEqual({ action: "check_availability", day: "lunes", edge: "latest" });
    expect(g.changes).toEqual([]);
  });

  it("un `edge` contrario a lo que pidió el cliente se quita (no se invierte a ciegas)", () => {
    const g = guardAgendaAction(
      { action: "check_availability", day: "lunes", edge: "earliest" as const },
      "dame el último horario del lunes"
    );
    expect((g.action as { edge?: string }).edge).toBeUndefined();
    expect(g.changes).toContain("edge_removed");
  });

  it("FALLO 2: cadenas vacías, espacios y arreglos vacíos son ausencia", () => {
    const g = guardAgendaAction(
      { action: "check_availability", day: "el lunes", times: ["11", "12"], from: "", to: "  ", edge: "" },
      "¿Puedes el lunes a las 11 o 12?"
    );
    expect(g.action).toEqual({ action: "check_availability", day: "el lunes", times: ["11", "12"] });
    expect(g.changes).toContain("empty_fields_dropped");
    const g2 = guardAgendaAction(
      { action: "check_availability", day: "mañana", times: [] },
      "¿Tienes más horarios mañana?"
    );
    expect(g2.action).toEqual({ action: "check_availability", day: "mañana" });
  });

  it("FALLO 3: `offer_slots` ante «la semana que viene» ES check_availability con el texto original", () => {
    const g = guardAgendaAction(
      { action: "offer_slots", reply: "Claro, estos son algunos horarios:" },
      "¿Tienes disponibilidad la semana que viene?"
    );
    expect(g.action).toEqual({ action: "check_availability", day: "la semana que viene" });
    expect(g.changes).toEqual(["rerouted_offer_slots_to_check_availability"]);
  });

  it.each([
    ["¿Puedes el lunes a las 11 o 12?", { day: "el lunes", times: ["11", "12"] }],
    ["¿Tienes el lunes a las 4 o 5 de la tarde?", { day: "el lunes", times: ["4 de la tarde", "5 de la tarde"] }],
    ["¿Cuál es el horario más tarde del lunes?", { day: "lunes", edge: "latest" }],
    ["¿Tienes más horarios mañana?", { day: "mañana" }],
    ["quiero agendar para el 25 de septiembre", { day: "el 25 de septiembre" }],
  ])("offer_slots con «%s» → check_availability", (text, fields) => {
    const g = guardAgendaAction({ action: "offer_slots" }, text);
    expect(g.action).toEqual({ action: "check_availability", ...fields });
  });

  it.each([
    "quiero agendar una llamada",
    "¿Qué horarios tienes?",
    "sí, quiero verlos",
    "por la tarde me va mejor",
  ])("offer_slots genérico («%s») se respeta", (text) => {
    const action = { action: "offer_slots" as const, reply: "Claro" };
    const g = guardAgendaAction(action, text);
    expect(g.action).toBe(action);
    expect(g.changes).toEqual([]);
  });

  it("nunca toca book_slot (aceptar un horario ofrecido menciona día y hora a propósito) ni reply", () => {
    const book = { action: "book_slot", startUtc: "2026-09-21T15:00:00.000Z" };
    expect(guardAgendaAction(book, "el lunes a las 11 me sirve").action).toBe(book);
    const reply = { action: "reply", text: "ok" };
    expect(guardAgendaAction(reply, "el lunes a las 11").action).toBe(reply);
  });

  it("es idempotente", () => {
    const once = guardAgendaAction({ action: "offer_slots" }, "¿Puedes el lunes a las 11 o 12?").action;
    const twice = guardAgendaAction(once, "¿Puedes el lunes a las 11 o 12?").action;
    expect(twice).toEqual(once);
  });
});
