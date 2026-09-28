import { describe, expect, it } from "vitest";
import { agentActionSchema, degradeAction } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { aiMockCompletion } from "@/server/dev/ai-mock";

/**
 * Spec 025 §3 — la acción `check_availability`: sin `reply` (el modelo no
 * afirma nada de horarios), sólo con la agenda encendida, con `edge` acotado, y
 * el prompt le prohíbe deducir o negar disponibilidad.
 */

const profile = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Max",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as Parameters<typeof buildAgentSystemPrompt>[0]["profile"];

const prompt = (agenda: boolean) =>
  buildAgentSystemPrompt({ profile, kb: [], stages: [{ name: "Nuevo" }], agenda });

describe("esquema", () => {
  const withAgenda = agentActionSchema(true);

  it("acepta la consulta con las palabras del prospecto, todos los campos opcionales", () => {
    for (const input of [
      { action: "check_availability" },
      { action: "check_availability", day: "mañana" },
      { action: "check_availability", day: "lunes", times: ["11", "12"] },
      { action: "check_availability", day: "lunes", times: ["4 de la tarde", "5 de la tarde"] },
      { action: "check_availability", day: "martes", from: "3 pm", to: "5 pm" },
      { action: "check_availability", edge: "latest" },
      { action: "check_availability", day: "25 de septiembre", edge: "earliest" },
    ]) {
      expect(withAgenda.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it("rechaza un `edge` inventado y una hora que no es texto", () => {
    expect(withAgenda.safeParse({ action: "check_availability", edge: "middle" }).success).toBe(false);
    expect(withAgenda.safeParse({ action: "check_availability", times: [11, 12] }).success).toBe(false);
    expect(withAgenda.safeParse({ action: "check_availability", times: "11" }).success).toBe(false);
  });

  it("NO lleva `reply`: lo que el modelo escriba ahí se descarta, nunca llega al prospecto", () => {
    const parsed = withAgenda.safeParse({
      action: "check_availability",
      day: "mañana",
      reply: "No tengo horarios mañana",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "reply" in parsed.data).toBe(false);
  });

  it("con la agenda APAGADA la acción no existe (el modelo ni puede nombrarla)", () => {
    expect(agentActionSchema(false).safeParse({ action: "check_availability", day: "mañana" }).success).toBe(false);
  });

  it("degradarla (no hay nada que responder por su cuenta) es callar, no inventar", () => {
    expect(degradeAction({ action: "check_availability", day: "mañana" })).toEqual({ action: "none" });
  });
});

describe("prompt", () => {
  it("con agenda: documenta la acción y prohíbe deducir o negar disponibilidad", () => {
    const p = prompt(true);
    expect(p).toContain('"action":"check_availability"');
    expect(p).toMatch(/No lleva reply/);
    expect(p).toMatch(/MUESTRA, no la agenda completa/);
    expect(p).toMatch(/NUNCA deduzcas la disponibilidad/);
    expect(p).toMatch(/NUNCA digas que no hay horarios ni disponibilidad/);
    // offer_slots se presenta como SUGERENCIAS y se invita a nombrar día/hora.
    expect(p).toMatch(/ALGUNAS opciones/);
    expect(p).toMatch(/invita al cliente a decir el día u hora/);
  });

  it("sin agenda: ni una palabra de horarios (no se gasta un token)", () => {
    const p = prompt(false);
    expect(p).not.toContain("check_availability");
    expect(p).not.toMatch(/disponibilidad/);
  });
});

describe("ai-mock (dispara la acción real en el self-test)", () => {
  const reply = (userText: string) =>
    JSON.parse(
      aiMockCompletion([
        { role: "system", content: prompt(true) },
        { role: "user", content: userText },
      ])
    ) as Record<string, unknown>;

  it.each([
    ["¿Tienes más horarios mañana?", { day: "mañana" }],
    ["¿Lunes a las 11 o 12?", { day: "lunes", times: ["11", "12"] }],
    ["¿El lunes a las 4 o 5 de la tarde?", { day: "lunes", times: ["4 de la tarde", "5 de la tarde"] }],
    ["¿Cuál es el horario más tarde el lunes?", { day: "lunes", edge: "latest" }],
    ["¿Cuál es el horario más tarde?", { edge: "latest" }],
  ])("«%s» → check_availability", (text, expected) => {
    expect(reply(text)).toEqual({ action: "check_availability", ...expected });
  });

  it("«quiero agendar una cita» sigue siendo offer_slots (las sugerencias)", () => {
    expect(reply("quiero agendar una cita")).toMatchObject({ action: "offer_slots" });
  });
});
