import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import {
  bootScenario,
  deliverInbound,
  resetData,
  settle,
  teardownScenario,
} from "./helpers/scenario";

/**
 * Spec 025 (revisión correctiva) — con el PERFIL HEREDADO («Usa offer_slots») y un
 * modelo que se equivoca de las tres formas que mostró la prueba real con el
 * perfil de producción, lo que ve el prospecto sigue saliendo del motor real:
 *
 *   1. `edge:"earliest"` indebido en «¿Tienes más horarios mañana?»  → el día COMPLETO.
 *   2. cadenas vacías / arreglos vacíos                              → ausencia.
 *   3. `offer_slots` ante un día/hora/rango/«la semana que viene»    → check_availability
 *      (aclaración del servidor si no entiende la expresión).
 *
 * Nada de esto llama a la IA una segunda vez ni toca `offerSlots`. Y `offer_slots`
 * genérico («quiero agendar») sigue siendo `offer_slots`.
 *
 * «Ahora» = jueves 17 sep 2026, 12:00 hora de Ciudad de México.
 */

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-17T18:00:00Z"));
  await bootScenario();
});
afterAll(async () => {
  vi.useRealTimers();
  await teardownScenario();
});

/** Instrucciones de un dueño con la regla heredada, tal cual: NO se sanean. */
const LEGACY_INSTRUCTIONS =
  "Eres Max. Cuando el cliente quiera agendar o pregunte por horarios y disponibilidad, Usa offer_slots para mostrarle los horarios.";

async function setInstructions(value: string | null) {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().update(schema.agentProfile).set({ instructions: value });
}

beforeEach(async () => {
  harness.reset();
  harness.availability.useReal = true;
  await resetData();
  await setInstructions(LEGACY_INSTRUCTIONS);
});
afterEach(async () => {
  await setInstructions(null);
});

const nowSec = () => Math.floor(Date.now() / 1000);
const model = (data: Record<string, unknown>) => ({ ok: true, data, raw: "{}" });
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(d);
const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const label = (d: Date) => `${dayOf(d)} ${hhmm(d)}`;

async function ask(text: string) {
  await deliverInbound({ text, timestamp: nowSec() });
  const snap = await settle();
  const out = snap.messages.filter((m) => m.direction === "out");
  const shown = snap.offers.filter((o) => o.shown).map((o) => label(o.startUtc)).sort();
  return { snap, out, shown };
}

const CLARIFY_TEXT =
  "¿Para qué día quieres que lo revise? Dime, por ejemplo, «mañana», «el lunes» o una fecha como «25 de septiembre».";
const FRIDAY_FULL =
  "Mañana viernes, 18 de septiembre puedo iniciar de 09:00 a 17:30 (cada 30 min). Cada sesión dura 30 min.";

describe("FALLO 3 · el perfil heredado no puede convertir una consulta con día/hora en offer_slots", () => {
  it("«¿Tienes disponibilidad la semana que viene?» + modelo offer_slots ⇒ el servidor pide la aclaración; NO se ofrece nada", async () => {
    harness.ai.script.push(model({ action: "offer_slots", reply: "Claro, aquí tienes algunos horarios:" }));
    const { snap, out, shown } = await ask("¿Tienes disponibilidad la semana que viene?");

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(CLARIFY_TEXT);
    expect(/\d{1,2}:\d{2}/.test(out[0]!.text ?? "")).toBe(false); // ni una hora
    expect(snap.offers).toHaveLength(0); // no se registró ningún horario
    expect(shown).toEqual([]);
    expect(harness.counts.offerSlots).toBe(0); // offer_slots JAMÁS corrió
    expect(harness.ai.calls).toBe(1); // sin segunda llamada de IA
    expect(snap.conversations[0]!.handoffAt).toBeNull();
  });

  it.each([
    ["¿Puedes el lunes a las 11 o 12?", ["2026-09-21 11:00", "2026-09-21 12:00"]],
    ["¿Tienes el lunes a las 4 o 5 de la tarde?", ["2026-09-21 16:00", "2026-09-21 17:00"]],
    ["¿Cuál es el horario más tarde del lunes?", ["2026-09-21 17:30"]],
  ])("«%s» + modelo offer_slots ⇒ exactamente lo que dice el motor", async (text, expected) => {
    harness.ai.script.push(model({ action: "offer_slots", reply: "Claro:" }));
    const { snap, shown } = await ask(text);
    expect(shown).toEqual(expected);
    expect(harness.counts.offerSlots).toBe(0);
    expect(harness.ai.calls).toBe(1);
    expect(harness.availability.calls).toBe(1);
    expect(snap.messages.filter((m) => m.direction === "out")).toHaveLength(1);
  });

  it("«quiero agendar una llamada» (sin día/hora/rango) sigue siendo offer_slots: la regla heredada se aplica donde corresponde", async () => {
    harness.ai.script.push(model({ action: "offer_slots", reply: "Claro, aquí tienes algunos horarios:" }));
    const { snap, out } = await ask("Quiero agendar una llamada");
    expect(harness.counts.offerSlots).toBe(1);
    expect(out).toHaveLength(1);
    expect(snap.offers.length).toBeGreaterThan(0);
    expect(harness.ai.calls).toBe(1);
  });

  it("book_slot con día y hora en el mensaje NO se reencamina (aceptar un horario ofrecido)", async () => {
    // Primero se le ofrece algo…
    harness.ai.script.push(model({ action: "offer_slots", reply: "Claro:" }));
    const first = await ask("Quiero agendar");
    const target = first.snap.offers[0]!;
    // …y luego acepta con día y hora: el modelo agenda, el servidor no lo toca.
    harness.ai.script.push(model({ action: "book_slot", startUtc: target.startUtc.toISOString(), reply: "¡Listo!" }));
    await deliverInbound({ text: `El ${dayOf(target.startUtc)} a las ${hhmm(target.startUtc)} me sirve`, timestamp: nowSec() });
    const after = await settle();
    expect(harness.counts.bookSlot).toBe(1);
    expect(after.bookings).toHaveLength(1);
  });

  it("la reconducción queda registrada SIN texto del cliente", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      harness.ai.script.push(model({ action: "offer_slots" }));
      await ask("¿Tienes disponibilidad la semana que viene?");
    } finally {
      spy.mockRestore();
    }
    const guardLine = lines.find((l) => l.includes("event=action_guard"));
    expect(guardLine).toBeDefined();
    expect(guardLine).toContain("outcome=rerouted_offer_slots_to_check_availability");
    expect(lines.join("\n")).not.toContain("semana que viene");
  });
});

describe("FALLOS 1 y 2 · `edge` indebido y campos vacíos", () => {
  it("«¿Tienes más horarios mañana?» con `edge:\"earliest\"` ⇒ el DÍA COMPLETO (18 horarios), no uno solo", async () => {
    harness.ai.script.push(
      model({ action: "check_availability", day: "mañana", edge: "earliest", times: [], from: "", to: "" })
    );
    const { snap, out, shown } = await ask("¿Tienes más horarios mañana?");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(FRIDAY_FULL);
    expect(shown).toHaveLength(18);
    expect(shown[0]).toBe("2026-09-18 09:00");
    expect(shown.at(-1)).toBe("2026-09-18 17:30");
    expect(snap.offers.every((o) => o.shown)).toBe(true);
    expect(harness.ai.calls).toBe(1);
  });

  it.each(["¿Qué horarios hay mañana?", "¿Tienes disponibilidad mañana?"])("«%s» tampoco se convierte en extremo", async (text) => {
    harness.ai.script.push(model({ action: "check_availability", day: "mañana", edge: "latest" }));
    const { out, shown } = await ask(text);
    expect(out[0]!.text).toBe(FRIDAY_FULL);
    expect(shown).toHaveLength(18);
  });

  it("horas concretas con `from:\"\"`, `to:\"  \"` y `edge:\"\"` ⇒ sólo las horas pedidas", async () => {
    harness.ai.script.push(
      model({ action: "check_availability", day: "el lunes", times: ["11", "12"], from: "", to: "  ", edge: "" })
    );
    const { out, shown } = await ask("¿Puedes el lunes a las 11 o 12?");
    expect(shown).toEqual(["2026-09-21 11:00", "2026-09-21 12:00"]);
    expect(out[0]!.text).toBe("Lunes, 21 de septiembre sí tengo libre a las 11:00 y 12:00.");
    expect(harness.ai.calls).toBe(1);
  });

  it("`day:\"\"` con `times:[]` (sin nada que consultar) ⇒ el panorama general, no una consulta vacía rara", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "", times: [], from: "", to: "" }));
    const { out, snap } = await ask("¿Qué tienes libre?");
    expect(out).toHaveLength(1);
    expect(snap.messages.filter((m) => m.direction === "out")[0]!.text).not.toBe("");
    expect(harness.ai.calls).toBe(1);
  });

  it("un `edge` que el cliente SÍ pidió sigue funcionando: «el horario más tarde del lunes» ⇒ 17:30", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "lunes", edge: "latest" }));
    const { shown } = await ask("¿Cuál es el horario más tarde del lunes?");
    expect(shown).toEqual(["2026-09-21 17:30"]);
  });
});
