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
 * Spec 024 §5.7 — la RE-OFERTA de `bookSlot` (el horario elegido acaba de
 * ocuparse y el agente propone alternativas) usa la misma vía íntegra que
 * `offer_slots`: el mensaje y sus horarios se persisten juntos, los horarios
 * nacen `pending`, sólo se activan cuando Meta acepta, se revalidan antes de
 * cada reintento y el reenvío manual pasa por el mismo guard.
 */

const TUESDAY_0900 = "2026-09-22T15:00:00.000Z";
const T503 = { ok: false, status: 503, code: 2 } as const;
const PERMANENT = { ok: false, status: 400, code: 131026 } as const;

/**
 * Las 3 alternativas frescas cuando el martes 09:00 ya no está libre. Desde la
 * spec 025 son las más CERCANAS a lo pedido (martes 10:00 el mismo día; lunes y
 * miércoles a las 09:00, la misma hora), no las primeras del horizonte.
 */
const REOFFER = [
  "Se me acaba de ocupar ese horario, ¡perdón!",
  "• 21 sep, 9:00",
  "• 22 sep, 10:00",
  "• 23 sep, 9:00",
].join("\n");

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
  await resetData();
});

const nowSec = () => Math.floor(Date.now() / 1000);

async function orgId(): Promise<string> {
  const { getDb, schema } = await import("@/lib/db");
  const r = await getDb().select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return r[0]!.id;
}

/** Turno 1: el agente ofrece horarios y Meta acepta → ronda vigente R1 (`active`). */
async function firstRound() {
  await deliverInbound({ text: "Sí, quiero agendar", timestamp: nowSec() });
  const snap = await settle();
  const r1 = snap.messages.find((m) => m.direction === "out")!;
  expect(r1.offerState).toBe("active");
  return r1;
}

/**
 * El martes 09:00 se ocupa DE VERDAD: un bloqueo en la base (lo que `findSlot`,
 * el motor real de reserva, respeta) y, para las alternativas frescas, también
 * desaparece de la disponibilidad simulada.
 */
async function occupyTuesday() {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/db/ids");
  await getDb().insert(schema.booking).values({
    id: newId("booking"),
    organizationId: await orgId(),
    kind: "block",
    scheduledAt: new Date(TUESDAY_0900),
    durationMinutes: 60,
  });
  harness.availability.slots = harness.availability.slots.filter((s) => s.startUtc !== TUESDAY_0900);
}

/** Turno 2: el prospecto elige el martes 09:00, que ya no está libre → re-oferta R2. */
async function reofferTurn(...meta: Parameters<typeof harness.meta.script.push>) {
  await occupyTuesday();
  harness.ai.script.push({
    ok: true,
    data: { action: "book_slot", startUtc: TUESDAY_0900, reply: "¡Listo, quedó!" },
    raw: "{}",
  });
  harness.meta.script.push(...meta);
  await deliverInbound({ text: "El martes a las 9 me queda bien", timestamp: nowSec() });
}

async function resend(messageId: string) {
  const { resendText } = await import("@/server/inbox/send");
  return resendText({ messageId, organizationId: await orgId() });
}

/** Citas de SESIÓN creadas (el bloqueo que ocupa el martes no cuenta). */
async function sessionBookings(): Promise<number> {
  const { getDb, schema } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  const rows = await getDb()
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(eq(schema.booking.kind, "session"));
  return rows.length;
}

const roundOf = (offers: Awaited<ReturnType<typeof snapshot>>["offers"], messageId: string) =>
  offers.filter((o) => o.messageId === messageId);

describe("1 · slot_taken genera alternativas y el primer envío funciona", () => {
  it("el mensaje lleva exactamente las alternativas; sus horarios se activan al aceptar Meta", async () => {
    const r1 = await firstRound();
    const before = { ai: harness.ai.calls, offer: harness.counts.offerSlots };

    await reofferTurn({ ok: true, wamid: "wamid.OUT.REOFFER" });
    const snap = await settle();

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(2);
    const r2 = out.find((m) => m.id !== r1.id)!;
    expect(r2.text).toBe(REOFFER);
    expect(r2.status).toBe("pending");
    expect(r2.offerState).toBe("active");
    expect(sentBodies().at(-1)).toBe(REOFFER);

    // No se agendó nada y sólo el turno 2 llamó a la IA (una vez).
    expect(await sessionBookings()).toBe(0);
    expect(harness.counts.bookSlot).toBe(1);
    expect(harness.counts.offerSlots).toBe(before.offer); // no se re-ejecutó offer_slots
    expect(harness.ai.calls).toBe(before.ai + 1);

    // La ronda vigente ahora es la de las alternativas: 3 filas, mostradas, activas.
    const round = roundOf(snap.offers, r2.id);
    expect(round).toHaveLength(3);
    expect(round.every((o) => o.state === "active" && o.shown)).toBe(true);
    // La ronda anterior quedó sustituida (y su mensaje lo sabe).
    expect(snap.offers.every((o) => o.messageId === r2.id)).toBe(true);
    expect(snap.messages.find((m) => m.id === r1.id)!.offerState).toBe("superseded");
    const { getOffers } = await import("@/server/agenda/offers");
    expect((await getOffers(await orgId(), r2.conversationId)).map((o) => o.startUtc)).toEqual([
      "2026-09-21T15:00:00.000Z",
      "2026-09-22T16:00:00.000Z",
      "2026-09-23T15:00:00.000Z",
    ]);
  });

  it("slot_not_offered (el modelo inventó una hora) usa la misma vía: mismo contrato, sin activar antes de tiempo", async () => {
    await firstRound();
    harness.ai.script.push({
      ok: true,
      data: { action: "book_slot", startUtc: "2026-09-25T15:00:00.000Z" }, // jamás ofrecido
      raw: "{}",
    });
    harness.meta.script.push({ ok: true });
    await deliverInbound({ text: "el viernes a las 9", timestamp: nowSec() });
    const snap = await settle();

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(2);
    const r2 = out[1]!;
    expect(r2.text).toMatch(/^Déjame confirmarte los horarios que tengo:\n(• .+\n?){3}$/);
    expect(r2.offerState).toBe("active");
    expect(snap.bookings).toHaveLength(0);
    // Mostró 3, pero el catálogo completo (8) viaja ligado al mensaje.
    const round = roundOf(snap.offers, r2.id);
    expect(round).toHaveLength(8);
    expect(round.filter((o) => o.shown)).toHaveLength(3);
  });
});

describe("2 · fallo temporal: el reintento conserva EXACTAMENTE las alternativas", () => {
  it("mismo cuerpo, una sola burbuja, cero llamadas de IA/bookSlot/offer_slots durante el reintento", async () => {
    await firstRound();
    await reofferTurn(T503, { ok: true, wamid: "wamid.OUT.R2OK" });
    await settle();

    const calls = harness.meta.calls.slice(1); // las del turno 2
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toBe(REOFFER);
    expect(calls[1]!.text).toBe(REOFFER);
    const out = await outboundRows();
    expect(out).toHaveLength(2); // R1 + UNA sola burbuja de la re-oferta
    expect(out[1]!.status).toBe("pending");
    expect(out[1]!.waMessageId).toBe("wamid.OUT.R2OK");
    expect(out[1]!.deliveryAttempts).toBe(2);
    // El turno 2 llamó a la IA una vez y a bookSlot una vez: los reintentos, nada.
    expect(harness.ai.calls).toBe(2);
    expect(harness.counts.bookSlot).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(await sessionBookings()).toBe(0);
  });
});

describe("3 · una alternativa se ocupa durante el backoff", () => {
  const saved = { b: process.env.OUTBOX_RETRY_BASE_MS, c: process.env.OUTBOX_RETRY_CAP_MS };
  afterEach(() => {
    if (saved.b === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
    else process.env.OUTBOX_RETRY_BASE_MS = saved.b;
    if (saved.c === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
    else process.env.OUTBOX_RETRY_CAP_MS = saved.c;
  });

  it("el reintento NO envía las alternativas: offer_stale, sin envío parcial y la ronda vigente intacta", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    const r1 = await firstRound();
    await reofferTurn(T503);
    const r2 = await waitUntil(
      async () => (await outboundRows()).find((m) => m.id !== r1.id && m.status === "retrying"),
      { label: "re-oferta en retrying" }
    );
    const aiBefore = harness.ai.calls;

    // Durante la espera, alguien ocupa la primera alternativa (lunes 09:00).
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    await getDb().insert(schema.booking).values({
      id: newId("booking"),
      organizationId: await orgId(),
      kind: "block",
      scheduledAt: new Date("2026-09-21T15:00:00Z"),
      durationMinutes: 60,
    });
    const { runDueDeliveries } = await import("@/server/outbox");
    await runDueDeliveries({ now: new Date(Date.now() + 20 * 60_000) });

    expect(harness.meta.calls).toHaveLength(2); // R1 + el primer intento fallido; NADA más
    const out = await outboundRows();
    expect(out).toHaveLength(2);
    const stale = out.find((m) => m.id === r2.id)!;
    expect(stale.status).toBe("failed");
    expect(stale.errorClass).toBe("offer_stale");
    expect(stale.offerState).toBe("superseded");
    expect(stale.text).toBe(REOFFER); // payload íntegro conservado
    expect(stale.error).toMatch(/ocupado/);
    // La ronda vigente sigue siendo la de R1: la re-oferta caducada no la sustituyó.
    const snap = await snapshot();
    expect(out.find((m) => m.id === r1.id)!.offerState).toBe("active");
    expect(snap.offers.filter((o) => o.state === "active").every((o) => o.messageId === r1.id)).toBe(true);
    expect(harness.ai.calls).toBe(aiBefore);
    expect(harness.counts.bookSlot).toBe(1);
    // Y el reenvío manual sigue vetado.
    await expect(resend(r2.id)).rejects.toMatchObject({ code: "offer_stale" });
  });
});

describe("4 · ronda posterior: el reenvío manual se bloquea", () => {
  it("una re-oferta antigua NO sustituye la ronda vigente ni crea mensajes", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT); // la re-oferta falla de forma definitiva
    const afterR2 = await settle();
    const r2 = afterR2.messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    expect(r2.status).toBe("failed");
    expect(r2.text).toBe(REOFFER);
    // Nada de R2 está activo: R1 sigue siendo la ronda vigente.
    expect(afterR2.offers.filter((o) => o.messageId === r2.id).every((o) => o.state === "pending")).toBe(true);
    expect(afterR2.messages.find((m) => m.id === r1.id)!.offerState).toBe("active");

    // El prospecto insiste: el agente arma una ronda NUEVA (R3), que Meta acepta.
    await deliverInbound({ text: "¿tienes otros horarios?", timestamp: nowSec() });
    const afterR3 = await settle();
    const r3 = afterR3.messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id && m.id !== r2.id)!;
    expect(r3.offerState).toBe("active");

    const fp = JSON.stringify([
      afterR3.offers.map((o) => [o.id, o.messageId, o.state]).sort(),
      afterR3.messages.map((m) => [m.id, m.status, m.offerState]).sort(),
    ]);
    const calls = harness.meta.calls.length;
    const ai = harness.ai.calls;

    await expect(resend(r2.id)).rejects.toMatchObject({ code: "offer_stale" });

    expect(harness.meta.calls).toHaveLength(calls);
    expect(harness.ai.calls).toBe(ai);
    const s = await snapshot();
    expect(
      JSON.stringify([
        s.offers.map((o) => [o.id, o.messageId, o.state]).sort(),
        s.messages.map((m) => [m.id, m.status, m.offerState]).sort(),
      ])
    ).toBe(fp);
    expect(s.offers.every((o) => o.messageId === r3.id && o.state === "active")).toBe(true);
  });

  it("sin ronda posterior y con las alternativas todavía libres: el reenvío se permite, íntegro", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT);
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    const ai = harness.ai.calls;

    const res = await resend(r2.id);

    expect(res.status).toBe("pending");
    expect(harness.meta.calls.at(-1)!.text).toBe(REOFFER);
    expect(await outboundRows()).toHaveLength(2); // la misma burbuja
    expect(harness.ai.calls).toBe(ai);
    const snap = await snapshot();
    expect(snap.offers.every((o) => o.messageId === r2.id && o.state === "active")).toBe(true);
    expect(snap.messages.find((m) => m.id === r1.id)!.offerState).toBe("superseded");
  });

  it("una alternativa que dejó de estar disponible: el reenvío manual se bloquea", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT);
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    // El motor de HOY ya no ofrece el lunes 09:00.
    harness.availability.slots = harness.availability.slots.filter((s) => s.startUtc !== "2026-09-21T15:00:00.000Z");
    const calls = harness.meta.calls.length;
    await expect(resend(r2.id)).rejects.toMatchObject({ code: "offer_stale" });
    expect(harness.meta.calls).toHaveLength(calls);
    expect((await snapshot()).messages.find((m) => m.id === r1.id)!.offerState).toBe("active");
  });

  it("una alternativa VENCIDA: el reenvío manual se bloquea", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT);
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    await getDb()
      .update(schema.offeredSlot)
      .set({ startUtc: new Date("2026-09-10T15:00:00Z") })
      .where(eq(schema.offeredSlot.messageId, r2.id));
    await expect(resend(r2.id)).rejects.toMatchObject({ code: "offer_stale", message: expect.stringMatching(/venci/) });
    expect(harness.meta.calls).toHaveLength(2);
  });
});

describe("5 · dos operadores reenviando a la vez", () => {
  it("sólo uno lo hace: un envío, la misma burbuja, el payload original", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT);
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    const calls = harness.meta.calls.length;
    harness.meta.delayMs = 150;

    const results = await Promise.allSettled([resend(r2.id), resend(r2.id), resend(r2.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      expect(r.reason).toMatchObject({ code: "resend_conflict" });
    }
    expect(harness.meta.calls).toHaveLength(calls + 1);
    expect(harness.meta.calls.at(-1)!.text).toBe(REOFFER);
    expect(await outboundRows()).toHaveLength(2);
  });
});

describe("6 · reinicio del proceso entre intentos", () => {
  const saved = { b: process.env.OUTBOX_RETRY_BASE_MS, c: process.env.OUTBOX_RETRY_CAP_MS };
  afterEach(() => {
    if (saved.b === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
    else process.env.OUTBOX_RETRY_BASE_MS = saved.b;
    if (saved.c === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
    else process.env.OUTBOX_RETRY_CAP_MS = saved.c;
  });

  it("el reintento continúa desde lo persistido y manda las mismas alternativas, sin IA ni bookSlot", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    const r1 = await firstRound();
    await reofferTurn(T503, { ok: true, wamid: "wamid.OUT.AFTER" });
    await waitUntil(async () => (await outboundRows()).find((m) => m.id !== r1.id && m.status === "retrying"), {
      label: "retrying",
    });
    const before = { ...harness.counts, ai: harness.ai.calls, av: harness.availability.calls };

    // «Muere» el proceso: se pierden los módulos en memoria, no la base.
    const { stopOutboxWorker } = await import("@/server/outbox");
    stopOutboxWorker();
    vi.resetModules();
    const fresh = await import("@/server/outbox");
    const attempted = await fresh.runDueDeliveries({ now: new Date(Date.now() + 20 * 60_000) });

    expect(attempted).toBe(1);
    const r2 = (await outboundRows()).find((m) => m.id !== r1.id)!;
    expect(r2.status).toBe("pending");
    expect(r2.waMessageId).toBe("wamid.OUT.AFTER");
    expect(r2.offerState).toBe("active");
    expect(sentBodies().slice(1)).toEqual([REOFFER, REOFFER]);
    expect(harness.ai.calls).toBe(before.ai);
    expect(harness.counts.bookSlot).toBe(before.bookSlot);
    expect(harness.counts.offerSlots).toBe(before.offerSlots);
    expect(harness.counts.pipelineRuns).toBe(before.pipelineRuns);
    expect(harness.availability.calls).toBe(before.av); // el reintento no consultó el motor
  });
});

describe("7 · cero llamadas adicionales de IA", () => {
  it("de la re-oferta, sus reintentos y su reenvío manual sale UNA sola llamada de IA (la del turno)", async () => {
    const r1 = await firstRound(); // 1 llamada
    expect(harness.ai.calls).toBe(1);
    await reofferTurn(T503, T503, T503); // el turno 2: 1 llamada; 3 intentos agotados
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    expect(r2.status).toBe("failed");
    expect(harness.ai.calls).toBe(2);

    await resend(r2.id); // reenvío manual permitido
    expect(harness.ai.calls).toBe(2);
    expect(harness.counts.bookSlot).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(harness.counts.pipelineRuns).toBe(2);
  });
});

describe("8 · ninguna oferta queda `active` si Meta no aceptó el mensaje", () => {
  const saved = { b: process.env.OUTBOX_RETRY_BASE_MS, c: process.env.OUTBOX_RETRY_CAP_MS };
  afterEach(() => {
    if (saved.b === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
    else process.env.OUTBOX_RETRY_BASE_MS = saved.b;
    if (saved.c === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
    else process.env.OUTBOX_RETRY_CAP_MS = saved.c;
  });

  async function expectNothingActiveForR2(r1Id: string) {
    const snap = await snapshot();
    const r2 = snap.messages.find((m) => m.direction === "out" && m.id !== r1Id)!;
    const round = roundOf(snap.offers, r2.id);
    expect(round).toHaveLength(3);
    expect(round.every((o) => o.state === "pending")).toBe(true); // ninguna activa
    expect(r2.offerState).toBe("pending");
    // La ronda vigente sigue siendo la anterior, intacta (8 filas de R1).
    expect(roundOf(snap.offers, r1Id)).toHaveLength(8);
    expect(roundOf(snap.offers, r1Id).every((o) => o.state === "active")).toBe(true);
    const { getOffers } = await import("@/server/agenda/offers");
    const active = await getOffers(await orgId(), r2.conversationId);
    expect(active).toHaveLength(8); // sólo lo de R1: nada de las alternativas sin aceptar
  }

  it("mientras reintenta (retrying)", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    const r1 = await firstRound();
    await reofferTurn(T503);
    await waitUntil(async () => (await outboundRows()).find((m) => m.id !== r1.id && m.status === "retrying"), {
      label: "retrying",
    });
    await expectNothingActiveForR2(r1.id);
  });

  it("si Meta lo rechaza de forma definitiva (failed)", async () => {
    const r1 = await firstRound();
    await reofferTurn(PERMANENT);
    await settle();
    await expectNothingActiveForR2(r1.id);
  });

  it("si el resultado es ambiguo (delivery_unknown)", async () => {
    const r1 = await firstRound();
    await reofferTurn({ ok: false, status: 0, phase: "timeout" });
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect((await outboundRows()).find((m) => m.id !== r1.id)!.status).toBe("delivery_unknown");
    await expectNothingActiveForR2(r1.id);
  });

  it("y el prospecto NO puede elegir una alternativa que no llegó a ver (no era de la ronda vigente)", async () => {
    const r1 = await firstRound();
    // Una alternativa NUEVA (jamás ofrecida en R1) encabeza la disponibilidad de hoy.
    const extra = "2026-09-22T17:00:00.000Z"; // martes 11:00: mismo día que lo pedido → entra entre las cercanas
    harness.availability.slots = [
      { startUtc: extra, endUtc: "2026-09-22T17:30:00.000Z", label: "22 sep, 11:00" },
      ...harness.availability.slots,
    ];
    await reofferTurn(PERMANENT); // la re-oferta [extra, …] NO llega: Meta la rechaza
    const r2 = (await settle()).messages.filter((m) => m.direction === "out").find((m) => m.id !== r1.id)!;
    expect(r2.text).toContain("• 22 sep, 11:00");
    expect(r2.status).toBe("failed");

    // El prospecto (que nunca la vio) elige justo esa alternativa.
    harness.ai.script.push({ ok: true, data: { action: "book_slot", startUtc: extra }, raw: "{}" });
    harness.meta.script.push({ ok: true });
    await deliverInbound({ text: "el lunes a las 11", timestamp: nowSec() });
    const snap = await settle();

    // `pending` no es seleccionable: no se agendó; el agente re-ofrece la ronda REAL vigente (R1).
    expect(await sessionBookings()).toBe(0);
    const last = snap.messages.filter((m) => m.direction === "out").at(-1)!;
    expect(last.text).toMatch(/^Déjame confirmarte los horarios que tengo:/);
    expect(last.text).not.toContain("11:00");
  });
});
