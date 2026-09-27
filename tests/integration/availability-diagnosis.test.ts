import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import { bootScenario, resetData, teardownScenario } from "./helpers/scenario";

/**
 * Spec 025 §1 — DIAGNÓSTICO de las consultas de disponibilidad, con el motor
 * REAL (horario, zona horaria, duración, aviso mínimo, buffers, citas) y una
 * agenda VACÍA de lunes a viernes 09:00-18:00 (los valores por defecto).
 *
 * Se escribió ANTES de la corrección: los casos «caracterización» describen el
 * defecto con números y siguen siendo ciertos después (lo que cambia es que ya
 * no se infiere nada de ellos); los casos «contrato» fallaron en rojo.
 *
 * «Ahora» = jueves 17 sep 2026, 12:00 hora de Ciudad de México.
 */

const BOT_KEY = "bot-key-integration-0123456789";

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-17T18:00:00Z"));
  await bootScenario();
});
afterAll(async () => {
  vi.useRealTimers();
  await teardownScenario();
});
beforeEach(async () => {
  harness.reset();
  harness.availability.useReal = true;
  await resetData();
});

async function orgId(): Promise<string> {
  const { getDb, schema } = await import("@/lib/db");
  const r = await getDb().select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return r[0]!.id;
}

async function makeConversation() {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/db/ids");
  const org = await orgId();
  const contactId = newId("contact");
  await getDb().insert(schema.contact).values({
    id: contactId,
    organizationId: org,
    waIdentity: "5215500000055",
    phone: "5215500000055",
    name: "Prospecto de prueba",
  });
  const conversationId = newId("conversation");
  await getDb().insert(schema.conversation).values({
    id: conversationId,
    organizationId: org,
    contactId,
    lastInboundAt: new Date(),
  });
  return { conversationId, contactId, org };
}

/** La disponibilidad COMPLETA del horizonte (la verdad contra la que se mide). */
async function fullAvailability() {
  const { computeAvailability } = await import("@/server/agenda/availability");
  return computeAvailability(await orgId());
}

const dayOf = (startUtc: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(startUtc));
const timeOf = (startUtc: string) =>
  new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(startUtc));

describe("caracterización: qué ve el agente frente a lo que realmente hay", () => {
  it("agenda VACÍA: lo ofrecido es una fracción de lo libre y el lunes por la tarde NUNCA se ofrece", async () => {
    const all = await fullAvailability();
    const monday = all.filter((s) => dayOf(s.startUtc) === "2026-09-21");
    // La verdad: el lunes hay 18 inicios libres (09:00 a 17:30, cada 30 min).
    expect(monday).toHaveLength(18);
    expect(timeOf(monday[0]!.startUtc)).toBe("09:00");
    expect(timeOf(monday.at(-1)!.startUtc)).toBe("17:30");

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: await orgId(), conversationId: "cv_x" });
    expect(turn.status).toBe("offered");

    // Lo registrado como reservable: 12 de todo el horizonte (perDay = 3).
    expect(turn.offers).toHaveLength(12);
    expect(turn.offers!.length / all.length).toBeLessThan(0.2);
    const offeredMonday = turn.offers!.filter((o) => dayOf(o.startUtc) === "2026-09-21");
    expect(offeredMonday.map((o) => timeOf(o.startUtc))).toEqual(["09:00", "09:30", "10:00"]);

    // El lunes 16:00 está LIBRE, dentro del horario y sin cita… y no está en lo ofrecido:
    const mon1600 = monday.find((s) => timeOf(s.startUtc) === "16:00");
    expect(mon1600).toBeDefined();
    expect(turn.offers!.some((o) => o.startUtc === mon1600!.startUtc)).toBe(false);
    // Deducir «no hay a las 4» de esa lista sería inventar ocupación.
  });

  it("el texto de offer_slots no distingue «algunas sugerencias» de «todo lo que hay»", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: await orgId(), conversationId: "cv_x", intro: "Claro:" });
    expect(turn.text).toMatch(/^Claro:\n• .+\n• .+\n• .+$/); // tres líneas, sin ningún aviso de que hay más
  });
});

describe("contrato: lo que debe cumplirse (rojo antes de la corrección)", () => {
  it("offer_slots declara que su lista es PARCIAL (exhaustive:false, hasMore:true) y cuánto hay en total", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");
    const all = await fullAvailability();
    const turn = await offerSlots({ organizationId: await orgId(), conversationId: "cv_x" });
    expect(turn.availability).toMatchObject({
      exhaustive: false,
      hasMore: true,
      total: all.length,
    });
  });

  it("si el horario elegido se ocupa, las alternativas están CERCA de lo pedido (mismo día), no las primeras del horizonte", async () => {
    const { conversationId, contactId, org } = await makeConversation();
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    // El lunes 16:00 (22:00Z) se ocupa.
    await getDb().insert(schema.booking).values({
      id: newId("booking"),
      organizationId: org,
      kind: "block",
      scheduledAt: new Date("2026-09-21T22:00:00Z"),
      durationMinutes: 30,
    });
    const { createSessionBooking, BookingError } = await import("@/server/agenda/service");
    const err = await createSessionBooking({
      organizationId: org,
      conversationId,
      contactId,
      startUtc: "2026-09-21T22:00:00.000Z",
      source: "manual",
      requireOffer: false,
      registerAlternatives: false,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect(err.code).toBe("slot_taken");
    const days = err.slots.map((s: { startUtc: string }) => dayOf(s.startUtc));
    // Hoy: las 3 primeras del horizonte (jueves por la tarde). Debe: lunes, cerca de las 4.
    expect(days.filter((d: string) => d === "2026-09-21").length).toBeGreaterThanOrEqual(2);
    const times = err.slots.map((s: { startUtc: string }) => timeOf(s.startUtc));
    expect(times).toContain("15:30");
    expect(times).toContain("16:30");
  });

  it("GET /api/bot/availability no oculta días con agenda ni presenta su lista truncada como completa", async () => {
    const { conversationId } = await makeConversation();
    const { GET } = await import("@/app/api/bot/availability/route");
    const res = await GET(
      new Request(`http://localhost/api/bot/availability?conversationId=${conversationId}`, {
        headers: { "x-api-key": BOT_KEY },
      })
    );
    const json = (await res.json()) as {
      slots: unknown[];
      diasConAgenda: string[];
      exhaustive?: boolean;
      hasMore?: boolean;
    };
    const all = await fullAvailability();
    const trueDays = [...new Set(all.map((s) => dayOf(s.startUtc)))];
    // La verdad: 6 días con agenda en el horizonte (17, 18, 21, 22, 23, 24)…
    expect(trueDays).toHaveLength(6);
    // …y, en la ventana que la llamada pide por defecto (`days=5` → 17 a 21): 3 días.
    const windowDays = trueDays.filter((d) => d <= "2026-09-21");
    expect(windowDays).toEqual(["2026-09-17", "2026-09-18", "2026-09-21"]);
    // «Los días que NO están aquí no tienen agenda» (contrato 015) era FALSO: sólo salía el jueves.
    expect(json.diasConAgenda).toEqual(windowDays);
    expect((json as { diasConAgendaHorizonte?: string[] }).diasConAgendaHorizonte).toEqual(trueDays);
    // …y la lista truncada tiene que decirlo.
    expect(json.exhaustive).toBe(false);
    expect(json.hasMore).toBe(true);
  });
});
