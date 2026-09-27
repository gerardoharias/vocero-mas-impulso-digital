import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import {
  bootScenario,
  deliverInbound,
  outboundRows,
  resetData,
  sentBodies,
  settle,
  snapshot,
  teardownScenario,
  waitUntil,
} from "./helpers/scenario";

/**
 * Spec 025 — consultas directas de disponibilidad, con el motor REAL sobre
 * Postgres (horario, zona horaria, duración, buffers, aviso mínimo, citas) y el
 * pipeline completo: la respuesta sale de la agenda evaluada sobre lo pedido y
 * viaja por la misma vía íntegra de 024 (§5.6: `pending` con el mensaje,
 * `active` sólo al aceptar Meta, revalidación antes del reintento).
 *
 * «Ahora» = jueves 17 sep 2026, 12:00 hora de Ciudad de México.
 */

const BOT_KEY = "bot-key-integration-0123456789";
const T503 = { ok: false, status: 503, code: 2 } as const;
const MON_1600 = "2026-09-21T22:00:00.000Z"; // lunes 16:00 MX

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

const nowSec = () => Math.floor(Date.now() / 1000);

async function orgId(): Promise<string> {
  const { getDb, schema } = await import("@/lib/db");
  const r = await getDb().select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return r[0]!.id;
}

async function block(startUtc: string, minutes: number, extra: Record<string, unknown> = {}) {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/db/ids");
  await getDb().insert(schema.booking).values({
    id: newId("booking"),
    organizationId: await orgId(),
    kind: "block",
    scheduledAt: new Date(startUtc),
    durationMinutes: minutes,
    ...extra,
  } as typeof schema.booking.$inferInsert);
}

async function ask(query: Parameters<typeof import("@/server/agenda/availability-query").queryAvailability>[0]["query"]) {
  const { queryAvailability } = await import("@/server/agenda/availability-query");
  return queryAvailability({ organizationId: await orgId(), query });
}

async function truth() {
  const { computeAvailability } = await import("@/server/agenda/availability");
  return computeAvailability(await orgId());
}

const wall = (startUtc: string, tz = "America/Mexico_City") =>
  new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(startUtc)
  );
const dayOf = (startUtc: string, tz = "America/Mexico_City") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(startUtc));

describe("el motor real: las cuatro consultas sobre una agenda VACÍA", () => {
  it("una sola consulta al motor por pregunta, y las respuestas coinciden con la verdad", async () => {
    const before = harness.availability.calls;
    const tomorrow = await ask({ day: "mañana" });
    expect(harness.availability.calls - before).toBe(1);

    const all = await truth();
    const friday = all.filter((s) => dayOf(s.startUtc) === "2026-09-18");
    expect(friday).toHaveLength(18);
    expect(tomorrow.text).toContain("puedo iniciar de 09:00 a 17:30 (cada 30 min)");
    expect(tomorrow.offers.map((o) => o.startUtc)).toEqual(friday.map((s) => s.startUtc));
    expect(tomorrow.meta).toMatchObject({ exhaustive: true, hasMore: false, total: 18, scopeComplete: true });

    const times = await ask({ day: "lunes", times: ["11", "12"] });
    expect(times.text).toContain("sí tengo libre a las 11:00 y 12:00");
    const pm = await ask({ day: "lunes", times: ["4 de la tarde", "5 de la tarde"] });
    expect(pm.text).toContain("sí tengo libre a las 16:00 y 17:00");
    const latest = await ask({ day: "lunes", edge: "latest" });
    expect(latest.text).toContain("a las 17:30");
  });

  it("agenda vacía 09:00-18:00: ofrece correctamente los horarios POSTERIORES a las primeras opciones, sin inventar ocupación", async () => {
    // 1) Lo que ve el prospecto primero: sugerencias 09:00 de tres días.
    const { offerSlots } = await import("@/server/agenda/agent");
    const first = await offerSlots({ organizationId: await orgId(), conversationId: "cv_x" });
    expect(first.text).toContain("a las 09:00");
    expect(first.availability).toMatchObject({ exhaustive: false, hasMore: true });

    // 2) «¿Tienes más horarios mañana?»: NO se deduce de esas tres; hay 18 y llegan hasta las 17:30.
    const more = await ask({ day: "mañana" });
    expect(more.text).toContain("de 09:00 a 17:30");
    expect(more.meta.total).toBe(18);
    const offered = more.offers.map((o) => wall(o.startUtc));
    expect(offered).toContain("13:00");
    expect(offered).toContain("16:30");
    expect(offered.at(-1)).toBe("17:30");
    // Nada de «no hay», «ocupado», «llena»…
    expect(more.text).not.toMatch(/no (hay|tengo|me quedan)|ocupad|llena|no está disponible/i);
    // Y cada horario ofrecido está libre de verdad.
    const free = new Set((await truth()).map((s) => s.startUtc));
    for (const o of more.offers) expect(free.has(o.startUtc)).toBe(true);
  });

  it("citas y bloqueos REALES en la base cambian la respuesta exactamente como el motor", async () => {
    await block("2026-09-21T19:00:00Z", 60); // lunes 13:00-14:00 MX
    await block("2026-09-22T23:30:00Z", 30); // martes 17:30-18:00 MX
    // Una cita CANCELADA libera el hueco y una de prueba no consume la agenda real.
    await block("2026-09-21T21:00:00Z", 60, { status: "cancelada" }); // lunes 15:00
    await block("2026-09-21T15:00:00Z", 60, { isTest: true }); // lunes 09:00

    const mon = await ask({ day: "lunes", times: ["1", "2", "3", "9"] });
    expect(mon.checks.map((c) => [c.hhmm, c.free, c.reason])).toEqual([
      ["13:00", false, "occupied"],
      ["14:00", true, undefined],
      ["15:00", true, undefined], // la cancelada libera
      ["09:00", true, undefined], // la de prueba no cuenta
    ]);
    expect((await ask({ day: "martes", edge: "latest" })).text).toContain("a las 17:00");

    // Coincide con el motor hora por hora.
    const free = new Set((await truth()).map((s) => s.startUtc));
    for (const c of mon.checks) {
      const iso = new Date(`2026-09-21T${String(Number(c.hhmm.slice(0, 2)) + 6).padStart(2, "0")}:${c.hhmm.slice(3)}:00.000Z`).toISOString();
      expect(free.has(iso)).toBe(c.free);
    }
  });

  it("zona horaria, duración, buffer y aviso mínimo configurados: la consulta coincide con el motor", async () => {
    const { upsertSettings } = await import("@/server/agenda/settings");
    await upsertSettings(await orgId(), {
      timezone: "America/Bogota", // UTC-5, sin DST
      slotMinutes: 45,
      bufferMinutes: 15,
      minNoticeHours: 24,
      maxDaysAhead: 7,
    });
    // Hoy = jueves 17 (12:00 MX = 13:00 Bogotá); aviso mínimo 24 h → mañana desde las 13:00.
    const day = await ask({ day: "lunes" });
    expect(day.text).toContain("de 09:00 a 17:00 (cada 60 min)");
    expect(day.text).toContain("Cada sesión dura 45 min.");
    const all = await truth();
    const monday = all.filter((s) => dayOf(s.startUtc, "America/Bogota") === "2026-09-21");
    expect(day.offers.map((o) => o.startUtc)).toEqual(monday.map((s) => s.startUtc));
    expect(wall(day.offers[0]!.startUtc, "America/Bogota")).toBe("09:00");
    expect(day.offers[0]!.startUtc).toBe("2026-09-21T14:00:00.000Z"); // 09:00 Bogotá = 14:00Z
    const notice = await ask({ day: "mañana", times: ["9", "14"] });
    expect(notice.checks.map((c) => [c.hhmm, c.free, c.reason])).toEqual([
      ["09:00", false, "too_soon"],
      ["14:00", true, undefined],
    ]);
    const grid = await ask({ day: "lunes", times: ["9:30"] });
    expect(grid.checks[0]).toMatchObject({ free: false, reason: "off_grid" });
  });
});

describe("el pipeline: una consulta directa viaja por la vía íntegra de 024", () => {
  const saved = { b: process.env.OUTBOX_RETRY_BASE_MS, c: process.env.OUTBOX_RETRY_CAP_MS };
  afterEach(() => {
    if (saved.b === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
    else process.env.OUTBOX_RETRY_BASE_MS = saved.b;
    if (saved.c === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
    else process.env.OUTBOX_RETRY_CAP_MS = saved.c;
  });

  const checkAction = (data: Record<string, unknown>) => ({
    ok: true,
    data: { action: "check_availability", ...data },
    raw: "{}",
  });

  it("«¿Tienes más horarios mañana?»: el mensaje ES la respuesta del motor; un solo turno de IA, sin offer_slots", async () => {
    harness.ai.script.push(checkAction({ day: "mañana" }));
    await deliverInbound({ text: "¿Tienes más horarios mañana?", timestamp: nowSec() });
    const snap = await settle();

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(
      "Mañana viernes, 18 de septiembre puedo iniciar de 09:00 a 17:30 (cada 30 min). Cada sesión dura 30 min."
    );
    expect(sentBodies()).toEqual([out[0]!.text]);
    expect(out[0]!.status).toBe("pending");
    expect(out[0]!.offerState).toBe("active"); // Meta aceptó
    // 18 horarios ligados al mensaje, ya activos, todos «mostrados».
    expect(snap.offers).toHaveLength(18);
    expect(snap.offers.every((o) => o.messageId === out[0]!.id && o.state === "active" && o.shown)).toBe(true);
    expect(harness.ai.calls).toBe(1);
    expect(harness.counts.offerSlots).toBe(0);
    expect(harness.availability.calls).toBe(1);
  });

  it("«¿El lunes a las 4 o 5?»: los horarios son `pending` MIENTRAS reintenta, y al aceptar Meta el prospecto SÍ puede elegir las 16:00", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    harness.ai.script.push(checkAction({ day: "lunes", times: ["4 de la tarde", "5 de la tarde"] }));
    harness.meta.script.push(T503, { ok: true, wamid: "wamid.OUT.Q1" });
    await deliverInbound({ text: "¿El lunes a las 4 o 5 de la tarde?", timestamp: nowSec() });
    const retrying = await waitUntil(async () => (await outboundRows()).find((m) => m.status === "retrying"), {
      label: "retrying",
    });
    expect(retrying.text).toBe("Lunes, 21 de septiembre sí tengo libre a las 16:00 y 17:00.");

    // Durante el backoff NADA es seleccionable ni se ha registrado como ofrecido.
    const mid = await snapshot();
    expect(mid.offers).toHaveLength(18);
    expect(mid.offers.every((o) => o.state === "pending")).toBe(true);
    const { getOffers } = await import("@/server/agenda/offers");
    expect(await getOffers(await orgId(), retrying.conversationId)).toEqual([]);

    // El reintento sale con EXACTAMENTE el mismo texto (un vencimiento simulado del backoff).
    const { runDueDeliveries } = await import("@/server/outbox");
    await runDueDeliveries({ now: new Date(Date.now() + 20 * 60_000) });
    expect(sentBodies()).toEqual([retrying.text, retrying.text]);
    const after = await snapshot();
    expect(after.offers.every((o) => o.state === "active")).toBe(true);
    expect(harness.ai.calls).toBe(1); // ni el backoff ni el reintento llamaron a la IA

    // Ahora el prospecto elige el lunes 16:00: ANTES era imposible (nunca se ofrecía).
    harness.ai.script.push({ ok: true, data: { action: "book_slot", startUtc: MON_1600, reply: "¡Listo!" }, raw: "{}" });
    await deliverInbound({ text: "El lunes a las 4", timestamp: nowSec() });
    const booked = await settle();
    expect(booked.bookings).toHaveLength(1);
    expect(booked.messages.filter((m) => m.direction === "out").at(-1)!.text).toContain("/cita/");
  });

  it("un hueco MOSTRADO se ocupa durante el backoff: offer_stale (sólo lo mostrado se revalida)", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    harness.ai.script.push(checkAction({ day: "lunes", times: ["4", "5"] }));
    harness.meta.script.push(T503);
    await deliverInbound({ text: "lunes 4 o 5", timestamp: nowSec() });
    const r = await waitUntil(async () => (await outboundRows()).find((m) => m.status === "retrying"), { label: "retrying" });

    // Un hueco REGISTRADO pero no mostrado (09:00) se ocupa: no vuelve obsoleta la respuesta.
    await block("2026-09-21T15:00:00Z", 30);
    const { runDueDeliveries } = await import("@/server/outbox");
    // (Antes de vencer el backoff: se comprueba la revalidación directamente.)
    const { checkOfferFreshness } = await import("@/server/agenda/offer-freshness");
    expect(await checkOfferFreshness(r.id)).toMatchObject({ applies: true, ok: true });

    // Un hueco MOSTRADO (16:00) se ocupa: el reintento NO envía.
    await block(MON_1600, 30);
    await runDueDeliveries({ now: new Date(Date.now() + 20 * 60_000) });
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.errorClass).toBe("offer_stale");
    expect(out[0]!.text).toBe(r.text); // payload íntegro conservado
    expect(harness.meta.calls).toHaveLength(1); // nada salió, ni parcial
    expect(harness.ai.calls).toBe(1);
    expect((await snapshot()).offers.every((o) => o.state === "pending")).toBe(true); // nunca activas
  });

  it("consulta que no entiende (día ambiguo): pregunta, no ofrece ni registra nada", async () => {
    harness.ai.script.push(checkAction({ day: "la semana que viene" }));
    await deliverInbound({ text: "la semana que viene", timestamp: nowSec() });
    const snap = await settle();
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toMatch(/¿Para qué día quieres que lo revise\?/);
    expect(out[0]!.offerState).toBeNull();
    expect(snap.offers).toHaveLength(0);
  });

  it("el motor CAE: se responde con un texto fijo que no afirma nada de horarios, sin handoff", async () => {
    harness.availability.fail = true;
    harness.ai.script.push(checkAction({ day: "mañana" }));
    await deliverInbound({ text: "mañana", timestamp: nowSec() });
    const snap = await settle();
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toMatch(/Tuve un problema al revisar la agenda/);
    expect(out[0]!.text).not.toMatch(/\d{2}:\d{2}/);
    expect(snap.conversations.filter((c) => c.handoffAt)).toHaveLength(0);
    expect(harness.ai.calls).toBe(1);
  });
});

describe("guard: una NEGACIÓN de agenda escrita por el modelo no se envía", () => {
  const negation = {
    ok: true,
    data: { action: "reply", text: "Lo siento, no tengo más horarios disponibles por ahora." },
    raw: "{}",
  };

  it("con agenda libre: se sustituye por lo que el motor dice de verdad (cero llamadas de IA extra)", async () => {
    harness.ai.script.push(negation);
    await deliverInbound({ text: "¿tienes algo más tarde?", timestamp: nowSec() });
    const snap = await settle();
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).not.toMatch(/no tengo más horarios/i);
    expect(out[0]!.text).toContain("puedo iniciar");
    expect(harness.ai.calls).toBe(1);
    expect(snap.offers.length).toBeGreaterThan(0);
    expect(out[0]!.offerState).toBe("active");
  });

  it("con la agenda REALMENTE llena, la negación sale, pero la dice el motor (con el alcance completo)", async () => {
    // Bloqueo de 08:00 a 20:00 en cada uno de los próximos 8 días.
    for (let d = 17; d <= 24; d++) {
      await block(`2026-09-${d}T13:00:00Z`, 12 * 60);
    }
    expect(await truth()).toHaveLength(0);
    harness.ai.script.push(negation);
    await deliverInbound({ text: "¿algo más?", timestamp: nowSec() });
    const snap = await settle();
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("No me quedan horarios libres en los próximos 7 días.");
    expect(harness.ai.calls).toBe(1);
  });

  it("un texto sin negación de agenda pasa tal cual", async () => {
    harness.ai.script.push({ ok: true, data: { action: "reply", text: "Claro, ¿en qué te ayudo?" }, raw: "{}" });
    await deliverInbound({ text: "hola", timestamp: nowSec() });
    const snap = await settle();
    expect(snap.messages.filter((m) => m.direction === "out")[0]!.text).toBe("Claro, ¿en qué te ayudo?");
    expect(harness.availability.calls).toBe(0);
  });
});

describe("GET /api/bot/availability (cerebro externo)", () => {
  let seq = 0;
  async function conversation() {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const org = await orgId();
    const contactId = newId("contact");
    await getDb().insert(schema.contact).values({
      id: contactId,
      organizationId: org,
      waIdentity: `52155000007${String(++seq).padStart(2, "0")}`,
      phone: `52155000007${String(seq).padStart(2, "0")}`,
      name: "Cerebro externo",
    });
    const id = newId("conversation");
    await getDb().insert(schema.conversation).values({ id, organizationId: org, contactId, lastInboundAt: new Date() });
    return id;
  }
  async function get(qs: string) {
    const cv = await conversation();
    const { GET } = await import("@/app/api/bot/availability/route");
    const res = await GET(
      new Request(`http://localhost/api/bot/availability?conversationId=${cv}${qs}`, {
        headers: { "x-api-key": BOT_KEY },
      })
    );
    return { res, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it("sin parámetros usa los valores por defecto (limit 12, 3 por día, 5 días) y declara que la lista es PARCIAL", async () => {
    const { res, json } = await get("");
    expect(res.status).toBe(200);
    // Ventana de 5 días desde el jueves 17: jueves, viernes y lunes tienen agenda → 3 por día.
    // (Antes: `Number(null)` daba 0 y el MÍNIMO ganaba → 1 hueco y 1 día.)
    expect(json.slots).toHaveLength(9);
    expect(new Set(json.slots.map((s: { dayIso: string }) => s.dayIso)).size).toBe(3);
    // `diasConAgenda` = días con agenda de la ventana pedida (`days=5`: jueves, viernes, lunes),
    // COMPLETO aunque la lista se trunque; el horizonte entero (6 días) va aparte.
    expect(json.diasConAgenda).toEqual(["2026-09-17", "2026-09-18", "2026-09-21"]);
    expect(json.diasConAgendaHorizonte).toHaveLength(6);
    expect(json).toMatchObject({ exhaustive: false, hasMore: true, scopeComplete: true, horizonDays: 7, kind: "suggestions" });
    const inWindow = (await truth()).filter((s) => {
      const d = dayOf(s.startUtc);
      return d >= "2026-09-17" && d <= "2026-09-21"; // days=5 por defecto
    });
    expect(json.total).toBe(inWindow.length);
  });

  it("`day` devuelve la disponibilidad COMPLETA de ese día, exhaustiva, con el mismo texto que el agente", async () => {
    const { json } = await get("&day=mañana");
    expect(json.slots).toHaveLength(18);
    expect(json).toMatchObject({ exhaustive: true, hasMore: false, total: 18, kind: "day" });
    expect(json.resumen).toContain("puedo iniciar de 09:00 a 17:30");
    expect(json.slots[0].time).toBe("09:00");
    expect(json.slots.at(-1).time).toBe("17:30");
  });

  it("`day`+`from`+`to`: rango completo; no reconocer el día es un 422 (no una lista vacía que parezca «no hay»)", async () => {
    const range = await get("&day=lunes&from=2%20pm&to=5%20pm");
    expect(range.json.slots.map((s: { time: string }) => s.time)).toEqual(["14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
    expect(range.json).toMatchObject({ exhaustive: true, kind: "range" });
    const bad = await get("&day=cuando%20puedas");
    expect(bad.res.status).toBe(422);
    expect(bad.json.error.code).toBe("invalid_query");
  });

  it("parámetros inválidos caen al valor por defecto, no al mínimo", async () => {
    const { json } = await get("&limit=abc&perDay=&days=xyz");
    expect(json.slots).toHaveLength(9); // limit 12 / perDay 3 / days 5 por defecto
    const wide = await get("&days=8&limit=48&perDay=8");
    expect(wide.json.slots.length).toBeGreaterThan(30); // los parámetros válidos SÍ mandan
  });

  it("026 — `altDays` (días alternativos) y `days` (ventana numérica) conviven en la MISMA llamada sin pisarse", async () => {
    // `days=3` (ventana) + `altDays=jueves,viernes` (días nombrados) a la vez: cada uno
    // gobierna lo suyo — la colisión de nombres real (026) se evitó llamando al nuevo "altDays".
    const { json } = await get("&days=3&altDays=jueves,viernes");
    expect(json.kind).toBe("days");
    expect(Array.isArray(json.slots)).toBe(true);
    // El `days=3` de la ventana sigue funcionando igual que siempre cuando NO hay day/altDays.
    const windowOnly = await get("&days=3");
    expect(windowOnly.json.kind).toBe("suggestions");
  });
});
