import { describe, expect, it } from "vitest";
import {
  CLARIFY_ATTEMPTS_LIMIT,
  EMPTY_CLARIFY_STATE,
  isUnambiguousTopicChange,
  mergeClarifyContext,
  nextAttemptNumber,
  parseClarifyContext,
  parseWeekChoiceReply,
  recordUnresolvedAttempt,
  referencesPendingClarify,
  sanitizeClarifyContext,
  serializeClarifyContext,
  type AgendaClarifyState,
} from "@/server/agenda/agenda-clarify-context";

/**
 * Spec 026 §3.3 — memoria de aclaración de disponibilidad: PURA, sin BD.
 */

describe("sanitizeClarifyContext / serializeClarifyContext / parseClarifyContext", () => {
  it("sólo conserva la forma conocida", () => {
    expect(sanitizeClarifyContext({ weekModifier: "next" })).toEqual({ weekModifier: "next" });
    expect(sanitizeClarifyContext({ weekModifier: "same" })).toEqual({ weekModifier: "same" });
    expect(sanitizeClarifyContext({ weekModifier: "bogus" })).toBeNull();
    expect(sanitizeClarifyContext({ days: ["jueves", "viernes"] })).toEqual({ days: ["jueves", "viernes"] });
    expect(sanitizeClarifyContext(null)).toBeNull();
    expect(sanitizeClarifyContext({})).toBeNull();
    expect(sanitizeClarifyContext("texto libre")).toBeNull();
  });

  it("nunca deja pasar más de 3 días ni palabras larguísimas (nunca un mensaje completo)", () => {
    const long = "x".repeat(500);
    expect(sanitizeClarifyContext({ days: ["a", "b", "c", "d", "e"] })).toEqual({ days: ["a", "b", "c"] });
    expect(sanitizeClarifyContext({ days: [long] })?.days?.[0]?.length).toBe(40);
  });

  it("nunca guarda datos ajenos a agenda (filtra claves desconocidas)", () => {
    expect(sanitizeClarifyContext({ weekModifier: "next", telefono: "5551234567", nombre: "Juan" })).toEqual({
      weekModifier: "next",
    });
  });

  it("serializa y relee sin pérdida", () => {
    const ctx = { weekModifier: "next" as const, days: ["jueves"] };
    const json = serializeClarifyContext(ctx);
    expect(json).not.toBeNull();
    expect(parseClarifyContext(json)).toEqual(ctx);
  });

  it("null si no hay nada que guardar, o si el JSON de un mensaje ajeno no parsea", () => {
    expect(serializeClarifyContext(null)).toBeNull();
    expect(parseClarifyContext(null)).toBeNull();
    expect(parseClarifyContext("no es json")).toBeNull();
    expect(parseClarifyContext("[1,2,3]")).toBeNull();
  });

  it("el JSON serializado siempre cabe en el tope (días acotados a 3×40 caracteres)", () => {
    const json = serializeClarifyContext({ weekModifier: "next", days: ["x".repeat(40), "y".repeat(40), "z".repeat(40)] });
    expect(json).not.toBeNull();
    expect(json!.length).toBeLessThanOrEqual(300);
  });
});

describe("referencesPendingClarify / isUnambiguousTopicChange", () => {
  it.each(["el jueves", "mañana", "25 de septiembre", "a las 4", "entre las 2 y las 4"])(
    "«%s» se refiere a la aclaración (trae temporalidad)",
    (t) => {
      expect(referencesPendingClarify(t)).toBe(true);
      expect(isUnambiguousTopicChange(t)).toBe(false);
    }
  );

  it.each(["esa", "esta", "la próxima", "sí", "si", "ok", "no", "la otra", "la primera"])(
    "respuesta corta compatible «%s» se conserva",
    (t) => {
      expect(referencesPendingClarify(t)).toBe(true);
      expect(isUnambiguousTopicChange(t)).toBe(false);
    }
  );

  it("un mensaje vacío es duda: se conserva", () => {
    expect(referencesPendingClarify("")).toBe(true);
    expect(referencesPendingClarify("   ")).toBe(true);
    expect(isUnambiguousTopicChange("")).toBe(false);
  });

  it("cambio inequívoco de tema: sin temporalidad ni respuesta corta, con contenido real", () => {
    expect(isUnambiguousTopicChange("¿cuánto cuesta el producto?")).toBe(true);
    expect(isUnambiguousTopicChange("quiero cancelar mi pedido")).toBe(true);
    expect(referencesPendingClarify("¿cuánto cuesta el producto?")).toBe(false);
  });

  it("ruido/puntuación sola no cuenta como cambio de tema (muy poco contenido)", () => {
    expect(isUnambiguousTopicChange("...")).toBe(false);
    expect(isUnambiguousTopicChange("?")).toBe(false);
  });
});

describe("parseWeekChoiceReply", () => {
  it("reconoce la elección corta de semana", () => {
    expect(parseWeekChoiceReply("esta")).toBe("same");
    expect(parseWeekChoiceReply("Esta semana")).toBe("same");
    expect(parseWeekChoiceReply("la próxima")).toBe("next");
    expect(parseWeekChoiceReply("próxima")).toBe("next");
    expect(parseWeekChoiceReply("la próxima semana")).toBe("next");
  });

  it("no confunde un día normal con una elección de semana", () => {
    expect(parseWeekChoiceReply("el jueves")).toBeNull();
    expect(parseWeekChoiceReply("")).toBeNull();
  });
});

describe("mergeClarifyContext — regla 10 (el turno actual manda)", () => {
  it("sin contexto: pasa la consulta tal cual", () => {
    expect(mergeClarifyContext(null, { day: "jueves" }, "el jueves")).toEqual({ query: { day: "jueves" } });
  });

  it("el cliente repite el día: hereda el calificador pendiente", () => {
    const merged = mergeClarifyContext({ weekModifier: "next" }, { day: "jueves" }, "el jueves");
    expect(merged.impliedWeekModifier).toBe("next");
    expect(merged.query.day).toBe("jueves");
  });

  it("«la próxima» sola responde la aclaración «¿esta semana o la próxima?» y hereda el día del contexto", () => {
    const merged = mergeClarifyContext({ days: ["jueves"] }, {}, "la próxima");
    expect(merged.impliedWeekModifier).toBe("next");
    expect(merged.query.day).toBe("jueves");
  });

  it("«esta» sola: semana actual, día heredado", () => {
    const merged = mergeClarifyContext({ days: ["jueves"] }, {}, "esta");
    expect(merged.impliedWeekModifier).toBe("same");
    expect(merged.query.day).toBe("jueves");
  });

  it("dos días pendientes: «la próxima» hereda AMBOS en `days`", () => {
    const merged = mergeClarifyContext({ days: ["jueves", "viernes"] }, {}, "la próxima");
    expect(merged.query.days).toEqual(["jueves", "viernes"]);
    expect(merged.query.day).toBeUndefined();
  });

  it("sin día en este turno pero con hora: hereda día + calificador (regla: «a las 4»)", () => {
    const merged = mergeClarifyContext({ weekModifier: "next", days: ["jueves"] }, { times: ["4"] }, "a las 4");
    expect(merged.query.day).toBe("jueves");
    expect(merged.query.times).toEqual(["4"]);
    expect(merged.impliedWeekModifier).toBe("next");
  });

  it("el cliente ya trae su propio día: el contexto NO lo pisa (aunque sí aporta el calificador implícito)", () => {
    const merged = mergeClarifyContext({ weekModifier: "next", days: ["jueves"] }, { day: "viernes" }, "el viernes");
    expect(merged.query.day).toBe("viernes"); // el turno actual manda
    expect(merged.impliedWeekModifier).toBe("next"); // resolveDayExpression sólo lo usa si "viernes" no trae uno propio
  });
});

describe("recordUnresolvedAttempt / nextAttemptNumber — regla 15 (límite de 3)", () => {
  it("el límite es EXACTAMENTE 3 (regla del dueño, no un valor genérico)", () => {
    expect(CLARIFY_ATTEMPTS_LIMIT).toBe(3);
  });

  it("con 3 turnos REALES (2, luego 3) escala justo en el tercero, nunca antes ni después", () => {
    const t1 = recordUnresolvedAttempt(EMPTY_CLARIFY_STATE, "unresolved_day", null);
    expect(t1.escalate).toBe(false);
    const t2 = recordUnresolvedAttempt(t1.state, "unresolved_day", null);
    expect(t2.escalate).toBe(false);
    const t3 = recordUnresolvedAttempt(t2.state, "unresolved_day", null);
    expect(t3.escalate).toBe(true);
    expect(t3.attempt).toBe(3);
  });

  it("cuenta intentos consecutivos y no escala antes del tope", () => {
    expect(nextAttemptNumber(EMPTY_CLARIFY_STATE)).toBe(1);
    const first = recordUnresolvedAttempt(EMPTY_CLARIFY_STATE, "unresolved_day", null);
    expect(first).toEqual({ escalate: false, attempt: 1, state: { count: 1, kind: "unresolved_day", context: null } });

    const second = recordUnresolvedAttempt(first.state, "already_passed_this_week", { days: ["jueves"] });
    expect(second.escalate).toBe(false);
    expect(second.attempt).toBe(2);
    expect(second.state).toEqual({
      count: 2,
      kind: "already_passed_this_week",
      context: { days: ["jueves"] },
    });
  });

  it(`escala en el intento ${CLARIFY_ATTEMPTS_LIMIT} y limpia el estado`, () => {
    const prev: AgendaClarifyState = { count: CLARIFY_ATTEMPTS_LIMIT - 1, kind: "unresolved_day", context: null };
    const outcome = recordUnresolvedAttempt(prev, "unresolved_day", null);
    expect(outcome.escalate).toBe(true);
    expect(outcome.attempt).toBe(CLARIFY_ATTEMPTS_LIMIT);
    expect(outcome.state).toEqual(EMPTY_CLARIFY_STATE);
  });
});
