import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, INCIDENT_INTRO } from "./setup";
import {
  bootScenario,
  conversationRow,
  deliverInbound,
  deliverStatus,
  outboundRows,
  resetData,
  sentBodies,
  settle,
  snapshot,
  teardownScenario,
  waitUntil,
} from "./helpers/scenario";

/**
 * Spec 024 §5 — entrega y reintento íntegro. Código real (ingesta → pipeline →
 * agenda → outbox → política) sobre Postgres real; sólo Meta, la IA y la
 * disponibilidad están simuladas.
 */

const FULL_MESSAGE = [
  INCIDENT_INTRO,
  "• lunes, 21 de septiembre a las 09:00",
  "• martes, 22 de septiembre a las 09:00",
  "• miércoles, 23 de septiembre a las 09:00",
].join("\n");

const TUESDAY_0900 = "2026-09-22T15:00:00.000Z";

const T503 = { ok: false, status: 503, code: 2 } as const;

beforeAll(async () => {
  // Antes del 21 de septiembre para que las etiquetas sean las del incidente.
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

afterEach(() => {
  vi.restoreAllMocks();
});

/** La organización de la prueba, leída de la base (sobrevive a `vi.resetModules`). */
async function orgId(): Promise<string> {
  const { getDb, schema } = await import("@/lib/db");
  const rows = await getDb().select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return rows[0]!.id;
}

async function startOfferTurn(text = "Sí, quiero agendar") {
  return deliverInbound({ text, timestamp: Math.floor(Date.now() / 1000) });
}

describe("1 · primer intento temporalmente fallido, segundo exitoso", () => {
  it("mismo cuerpo en ambos intentos, 3 horarios, una IA, una consulta, un offer_slots, una fila, cero handoffs", async () => {
    harness.meta.script.push(T503, { ok: true, wamid: "wamid.OUT.OK" });
    const { wamid } = await startOfferTurn();
    const snap = await settle();

    expect(harness.meta.calls).toHaveLength(2);
    const [first, second] = sentBodies();
    expect(first).toBe(FULL_MESSAGE);
    expect(second).toBe(first); // exactamente igual
    expect((second!.match(/^• /gm) ?? []).length).toBe(3);

    expect(harness.ai.calls).toBe(1);
    expect(harness.availability.calls).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(harness.counts.pipelineRuns).toBe(1);

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1); // una sola representación visible
    expect(out[0]!.status).toBe("pending");
    expect(out[0]!.waMessageId).toBe("wamid.OUT.OK");
    expect(out[0]!.error).toBeNull();
    expect(out[0]!.deliveryAttempts).toBe(2);
    expect(out[0]!.dedupeKey).toMatch(/^agent-turn:msg_/);
    expect(snap.conversations.filter((c) => c.handoffAt)).toHaveLength(0);

    // Dos intentos, del MISMO mensaje, con su clasificación saneada.
    expect(snap.attempts!.map((a) => [a.attempt_no, a.outcome, a.meta_code])).toEqual([
      [1, "transient_failure", 2],
      [2, "accepted", null],
    ]);
    expect(snap.attempts![1]!.wamid).toBe("wamid.OUT.OK");
    expect(wamid).toBe("wamid.IN.1");
  });

  it("los horarios quedan ligados al mensaje lógico y seleccionables tras el reintento exitoso", async () => {
    harness.meta.script.push(T503, { ok: true });
    await startOfferTurn();
    const snap = await settle();

    const out = snap.messages.find((m) => m.direction === "out")!;
    expect(snap.offers.length).toBe(8);
    expect(snap.offers.every((o) => o.messageId === out.id)).toBe(true);
    expect(snap.offers.every((o) => o.state === "active")).toBe(true);
  });
});

describe("2 · tres fallos temporales agotados", () => {
  it("termina en failed, conserva el payload completo y no genera mensajes alternativos", async () => {
    harness.meta.script.push(T503, T503, T503);
    await startOfferTurn();
    const snap = await settle();

    expect(harness.meta.calls).toHaveLength(3);
    for (const body of sentBodies()) expect(body).toBe(FULL_MESSAGE);

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1); // sin fallback, sin introducción sola
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.text).toBe(FULL_MESSAGE); // listo para reenvío manual
    expect(out[0]!.errorClass).toBe("transient");
    expect(out[0]!.errorCode).toBe(2);
    expect(out[0]!.deliveryAttempts).toBe(3);
    expect(out[0]!.error).toMatch(/Meta no está disponible/);
    expect(harness.ai.calls).toBe(1);
    expect(snap.conversations.filter((c) => c.handoffAt)).toHaveLength(0);

    // Los horarios NO se ofrecieron: nadie los vio, no son seleccionables.
    expect(snap.offers.every((o) => o.state === "pending")).toBe(true);
    const { getOffers } = await import("@/server/agenda/offers");
    expect(await getOffers(await orgId(), out[0]!.conversationId)).toEqual([]);
  });

  it("el reenvío MANUAL manda ese mismo payload, en la misma burbuja, y activa los horarios", async () => {
    harness.meta.script.push(T503, T503, T503);
    await startOfferTurn();
    const failed = (await settle()).messages.find((m) => m.direction === "out")!;
    expect(failed.status).toBe("failed");

    const { resendText } = await import("@/server/inbox/send");
    const res = await resendText({ messageId: failed.id, organizationId: await orgId() });
    expect(res.status).toBe("pending");

    const after = await outboundRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(failed.id);
    expect(harness.meta.calls).toHaveLength(4);
    expect(sentBodies()[3]).toBe(FULL_MESSAGE);
    expect((await snapshot()).offers.every((o) => o.state === "active")).toBe(true);
    expect(harness.ai.calls).toBe(1);
  });
});

describe("3 · error permanente", () => {
  it("no reintenta", async () => {
    harness.meta.script.push({ ok: false, status: 400, code: 131026 });
    await startOfferTurn();
    const snap = await settle();
    // Espera de sobra para que un reintento, si existiera, ya hubiera salido.
    await new Promise((r) => setTimeout(r, 400));

    expect(harness.meta.calls).toHaveLength(1);
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.errorClass).toBe("recipient_unavailable");
    expect(out[0]!.errorCode).toBe(131026);
    expect(out[0]!.text).toBe(FULL_MESSAGE);
    expect((await outboundRows()).length).toBe(1);
    expect(harness.meta.calls).toHaveLength(1);
  });
});

describe("4 · resultado ambiguo", () => {
  it.each([
    ["timeout", { ok: false, status: 0, phase: "timeout" }],
    ["corte de red tras conectar", { ok: false, status: 0, phase: "unknown" }],
    ["502 sin código de Meta", { ok: false, status: 502 }],
    ["500 sin código de Meta", { ok: false, status: 500 }],
    ["200 sin id de mensaje", { ok: true, noId: true }],
  ] as const)("%s → delivery_unknown, un solo envío, no se duplica solo", async (_n, entry) => {
    harness.meta.script.push(entry);
    await startOfferTurn();
    const snap = await settle();
    await new Promise((r) => setTimeout(r, 400));

    expect(harness.meta.calls).toHaveLength(1);
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("delivery_unknown");
    expect(out[0]!.errorClass).toBe("ambiguous");
    expect(out[0]!.text).toBe(FULL_MESSAGE);

    // Ni el barrido, ni el paso de las horas, lo reenvían.
    const { runDueDeliveries } = await import("@/server/outbox");
    await runDueDeliveries({ now: new Date(Date.now() + 3 * 3600_000) });
    expect(harness.meta.calls).toHaveLength(1);
    // Horarios sin evidencia de entrega: no seleccionables (spec D7).
    expect((await snapshot()).offers.every((o) => o.state === "pending")).toBe(true);
  });

  it("un fallo de red ANTES de conectar sí es seguro y se reintenta", async () => {
    harness.meta.script.push({ ok: false, status: 0, phase: "connect" }, { ok: true });
    await startOfferTurn();
    await settle();
    expect(harness.meta.calls).toHaveLength(2);
    expect(sentBodies()[1]).toBe(FULL_MESSAGE);
  });

  it("límite de frecuencia (130429) → reintentable, con su propia clase", async () => {
    harness.meta.script.push({ ok: false, status: 400, code: 130429 }, { ok: true });
    await startOfferTurn();
    const snap = await settle();
    expect(harness.meta.calls).toHaveLength(2);
    expect(snap.attempts![0]!.error_class).toBe("rate_limit");
    expect(snap.attempts![0]!.outcome).toBe("rate_limited");
  });
});

describe("5 · webhook de estado fallido tras obtener wamid", () => {
  it("código reintentable: actualiza el MISMO mensaje, reenvía el payload íntegro y una sola burbuja", async () => {
    harness.meta.script.push({ ok: true, wamid: "wamid.OUT.A1" });
    await startOfferTurn();
    await settle();

    await deliverStatus({ wamid: "wamid.OUT.A1", status: "failed", code: 131016 });
    const snap = await settle();

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(harness.meta.calls).toHaveLength(2);
    expect(sentBodies()).toEqual([FULL_MESSAGE, FULL_MESSAGE]);
    expect(out[0]!.status).toBe("pending");
    expect(out[0]!.waMessageId).not.toBe("wamid.OUT.A1");
    expect(snap.attempts!.map((a) => [a.attempt_no, a.outcome, a.meta_code, a.wamid])).toEqual([
      [1, "async_failed", 131016, "wamid.OUT.A1"],
      [2, "accepted", null, out[0]!.waMessageId],
    ]);
    expect(harness.ai.calls).toBe(1);

    // Un acuse tardío del wamid ANTERIOR ya no toca este mensaje.
    await deliverStatus({ wamid: "wamid.OUT.A1", status: "delivered" });
    expect((await outboundRows())[0]!.status).toBe("pending");
    // El del wamid vigente sí avanza.
    await deliverStatus({ wamid: out[0]!.waMessageId!, status: "delivered" });
    expect((await outboundRows())[0]!.status).toBe("delivered");
  });

  it.each([
    ["destinatario no disponible (131026)", 131026],
    ["límite de spam (131048)", 131048],
    ["ventana cerrada (131047)", 131047],
    ["código desconocido", 999999],
  ])("%s → failed definitivo, sin reintento", async (_n, code) => {
    harness.meta.script.push({ ok: true, wamid: "wamid.OUT.B1" });
    await startOfferTurn();
    await settle();

    await deliverStatus({ wamid: "wamid.OUT.B1", status: "failed", code });
    await settle();
    await new Promise((r) => setTimeout(r, 300));

    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.errorCode).toBe(code);
    expect(harness.meta.calls).toHaveLength(1); // ningún reintento
  });

  it("agotados los intentos, un failed asíncrono reintentable también cierra", async () => {
    // 3 intentos aceptados que Meta luego declara fallidos.
    harness.meta.script.push({ ok: true, wamid: "w.1" }, { ok: true, wamid: "w.2" }, {
      ok: true,
      wamid: "w.3",
    });
    await startOfferTurn();
    await settle();
    await deliverStatus({ wamid: "w.1", status: "failed", code: 131016 });
    await settle();
    await deliverStatus({ wamid: "w.2", status: "failed", code: 131016 });
    await settle();
    await deliverStatus({ wamid: "w.3", status: "failed", code: 131016 });
    await settle();

    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(harness.meta.calls).toHaveLength(3);
  });
});

describe("6 · evento entrante y turno duplicados", () => {
  it("el mismo evento dos veces no vuelve a ejecutar agente ni agenda", async () => {
    await deliverInbound({ text: "Sí, quiero agendar", wamid: "wamid.IN.DUP" });
    await deliverInbound({ text: "Sí, quiero agendar", wamid: "wamid.IN.DUP" });
    await settle();
    expect(harness.ai.calls).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(harness.meta.calls).toHaveLength(1);
  });

  it("el MISMO turno re-ejecutado (p. ej. tras un reinicio) no vuelve a llamar a IA ni a agenda", async () => {
    await startOfferTurn();
    await settle();
    const conv = await conversationRow();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn(conv.id);
    await runAgentTurn(conv.id);

    expect(harness.ai.calls).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(harness.availability.calls).toBe(1);
    expect(harness.meta.calls).toHaveLength(1);
    expect(await outboundRows()).toHaveLength(1);
  });
});

describe("7 · reinicio del proceso entre intentos", () => {
  const saved = {
    base: process.env.OUTBOX_RETRY_BASE_MS,
    cap: process.env.OUTBOX_RETRY_CAP_MS,
  };
  afterEach(() => {
    process.env.OUTBOX_RETRY_BASE_MS = saved.base;
    process.env.OUTBOX_RETRY_CAP_MS = saved.cap;
  });

  it("el reintento continúa desde lo persistido: sin IA, sin pipeline, sin agenda", async () => {
    // Reintento lejano: nada lo dispara antes de la «caída».
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    harness.meta.script.push(T503, { ok: true, wamid: "wamid.OUT.AFTER" });
    await startOfferTurn();
    const retrying = await waitUntil(
      async () => (await outboundRows()).find((m) => m.status === "retrying"),
      { label: "mensaje en retrying" }
    );
    expect(retrying.nextAttemptAt).not.toBeNull();
    expect(harness.meta.calls).toHaveLength(1);

    // «Muere» el proceso: se pierden los módulos en memoria, no la base.
    const before = { ...harness.counts, ai: harness.ai.calls, av: harness.availability.calls };
    const { stopOutboxWorker } = await import("@/server/outbox");
    stopOutboxWorker();
    vi.resetModules();
    const fresh = await import("@/server/outbox");
    const later = new Date(Date.now() + 20 * 60_000);
    const attempted = await fresh.runDueDeliveries({ now: later });

    expect(attempted).toBe(1);
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("pending");
    expect(out[0]!.waMessageId).toBe("wamid.OUT.AFTER");
    expect(sentBodies()).toEqual([FULL_MESSAGE, FULL_MESSAGE]);
    expect(harness.ai.calls).toBe(before.ai);
    expect(harness.availability.calls).toBe(before.av);
    expect(harness.counts.offerSlots).toBe(before.offerSlots);
    expect(harness.counts.pipelineRuns).toBe(before.pipelineRuns);
  });

  it("un trabajador NUEVO arrancado tras el reinicio retoma lo vencido por sí solo", async () => {
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    harness.meta.script.push(T503, { ok: true });
    await startOfferTurn();
    const retrying = await waitUntil(
      async () => (await outboundRows()).find((m) => m.status === "retrying"),
      { label: "retrying" }
    );
    // El reintento «vence» mientras el proceso estaba caído.
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    await getDb()
      .update(schema.message)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(schema.message.id, retrying.id));

    const { startOutboxWorker, stopOutboxWorker } = await import("@/server/outbox");
    stopOutboxWorker();
    startOutboxWorker();
    const done = await waitUntil(
      async () => (await outboundRows()).find((m) => m.status === "pending"),
      { label: "aceptado por el trabajador" }
    );
    stopOutboxWorker();
    expect(done.id).toBe(retrying.id);
    expect(sentBodies()).toEqual([FULL_MESSAGE, FULL_MESSAGE]);
    expect(harness.ai.calls).toBe(1);
  });

  it("un intento HUÉRFANO (murió con el envío en vuelo) no se reenvía: delivery_unknown", async () => {
    const { enqueueText, runDueDeliveries, startOutboxWorker, stopOutboxWorker } = await import("@/server/outbox");
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    await startOfferTurn();
    await settle();
    const conv = await conversationRow();
    // El trabajador de fondo se detiene mientras se FABRICA el estado huérfano: si no,
    // puede reclamar y enviar el mensaje recién encolado entre el `enqueue` y el
    // `update` (carrera del propio arnés, visible sólo con la máquina cargada).
    stopOutboxWorker();
    try {
      const { message } = await enqueueText({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        text: "Mensaje en vuelo",
        origin: "operator",
        aiGenerated: false,
      });
      await getDb()
        .update(schema.message)
        .set({
          status: "sending",
          deliveryAttempts: 1,
          lockedUntil: new Date(Date.now() - 5 * 60_000),
        })
        .where(eq(schema.message.id, message.id));
      const calls = harness.meta.calls.length;

      await runDueDeliveries({ now: new Date() });

      const row = (await outboundRows()).find((m) => m.id === message.id)!;
      expect(row.status).toBe("delivery_unknown");
      expect(harness.meta.calls.length).toBe(calls); // no salió nada
    } finally {
      startOutboxWorker();
    }
  });

  it("un mensaje que nunca llegó a intentarse (queued) sí se envía", async () => {
    const { enqueueText, runDueDeliveries } = await import("@/server/outbox");
    await startOfferTurn();
    await settle();
    const conv = await conversationRow();
    const { message } = await enqueueText({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      text: "Persistido, sin intento",
      origin: "operator",
      aiGenerated: false,
      now: new Date(Date.now() - 10 * 60_000),
    });
    await runDueDeliveries({ now: new Date() });
    const row = (await outboundRows()).find((m) => m.id === message.id)!;
    expect(row.status).toBe("pending");
    expect(harness.meta.calls.at(-1)!.text).toBe("Persistido, sin intento");
  });
});

describe("8 · dos trabajadores concurrentes", () => {
  it("sólo uno reclama y envía el intento", async () => {
    const saved = process.env.OUTBOX_RETRY_BASE_MS;
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    try {
      harness.meta.script.push(T503);
      await startOfferTurn();
      await waitUntil(
        async () => (await outboundRows()).find((m) => m.status === "retrying"),
        { label: "retrying" }
      );
      harness.meta.delayMs = 120; // la carrera es real: el envío tarda
      const { runDueDeliveries } = await import("@/server/outbox");
      const later = new Date(Date.now() + 20 * 60_000);
      const results = await Promise.all([
        runDueDeliveries({ now: later }),
        runDueDeliveries({ now: later }),
        runDueDeliveries({ now: later }),
      ]);

      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect(harness.meta.calls).toHaveLength(2); // el fallo + UN reintento
      const snap = await snapshot();
      expect(snap.attempts!.map((a) => a.attempt_no)).toEqual([1, 2]);
      expect(snap.messages.filter((m) => m.direction === "out")).toHaveLength(1);
    } finally {
      process.env.OUTBOX_RETRY_BASE_MS = saved;
      delete process.env.OUTBOX_RETRY_CAP_MS;
    }
  });

  it("el mismo intento reclamado en paralelo por dos llamadas directas: un solo envío", async () => {
    const { enqueueText, attemptDelivery } = await import("@/server/outbox");
    await startOfferTurn();
    await settle();
    const conv = await conversationRow();
    const { message } = await enqueueText({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      text: "Reclamo único",
      origin: "operator",
      aiGenerated: false,
    });
    const before = harness.meta.calls.length;
    harness.meta.delayMs = 80;
    const [a, b] = await Promise.all([
      attemptDelivery(message.id),
      attemptDelivery(message.id),
    ]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    expect(harness.meta.calls.length - before).toBe(1);
  });
});

describe("9 · el prospecto elige un horario tras el reintento", () => {
  it("la reserva se crea una sola vez y su confirmación llega íntegra", async () => {
    harness.meta.script.push(T503, { ok: true });
    await startOfferTurn();
    await settle();
    expect((await snapshot()).offers.every((o) => o.state === "active")).toBe(true);

    harness.ai.script.push({
      ok: true,
      data: { action: "book_slot", startUtc: TUESDAY_0900, reply: "¡Listo, quedó!" },
      raw: "{}",
    });
    await deliverInbound({
      text: "El martes a las 9 me queda bien",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const snap = await settle();

    expect(harness.counts.bookSlot).toBe(1);
    expect(snap.bookings).toHaveLength(1);
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(2);
    expect(out[1]!.text).toContain("¡Listo, quedó!");
    expect(out[1]!.text).toContain("/cita/");
  });

  it("si falla el envío de la CONFIRMACIÓN, la cita ya existe y el reintento la manda completa (sin rebookear)", async () => {
    await startOfferTurn();
    await settle();

    harness.ai.script.push({
      ok: true,
      data: { action: "book_slot", startUtc: TUESDAY_0900, reply: "¡Listo, quedó!" },
      raw: "{}",
    });
    harness.meta.script.push(T503, { ok: true });
    const callsBefore = harness.meta.calls.length;
    await deliverInbound({
      text: "El martes a las 9",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const snap = await settle();

    const confirmations = harness.meta.calls.slice(callsBefore);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]!.text).toBe(confirmations[0]!.text);
    expect(confirmations[1]!.text).toContain("/cita/");
    expect(harness.counts.bookSlot).toBe(1);
    expect(snap.bookings).toHaveLength(1);
    expect(snap.messages.filter((m) => m.direction === "out")).toHaveLength(2);
    expect(snap.conversations.filter((c) => c.handoffAt)).toHaveLength(0);
  });
});

describe("10 · privacidad", () => {
  it("los logs no contienen token, teléfono, conversación ni payload privado", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    // Recorre TODAS las rutas: éxito tras reintento, permanente, ambiguo y fallo asíncrono.
    harness.meta.script.push(T503, { ok: true, wamid: "wamid.OUT.P1" });
    await startOfferTurn("Sí, quiero agendar la limpieza dental");
    await settle();
    await deliverStatus({ wamid: "wamid.OUT.P1", status: "failed", code: 131026 });
    await settle();
    harness.meta.script.push({ ok: false, status: 400, code: 131026 });
    await deliverInbound({ text: "Otro mensaje privado", timestamp: Math.floor(Date.now() / 1000) });
    await settle();
    harness.meta.script.push({ ok: false, status: 0, phase: "timeout" });
    await deliverInbound({ text: "Tercer mensaje privado", timestamp: Math.floor(Date.now() / 1000) });
    await settle();

    const all = lines.join("\n");
    expect(all).toMatch(/\[outbox\]/); // sí hay logs operativos…
    for (const secret of [
      "EAAG-TOKEN-DE-PRUEBA",
      "5215500000001",
      "5500000001",
      "limpieza dental",
      "Sí, quiero agendar",
      "mensaje privado",
      "Perfecto",
      "septiembre",
      "horarios",
    ]) {
      expect(all, `el log filtró «${secret}»`).not.toContain(secret);
    }

    // Y la base sólo guarda campos saneados por intento.
    const snap = await snapshot();
    const dump = JSON.stringify(snap.attempts) + JSON.stringify(snap.messages.map((m) => m.error));
    expect(dump).not.toContain("EAAG-TOKEN");
    expect(dump).not.toContain("5215500000001");
    expect(dump).not.toContain("simulated meta error");
  });
});

describe("11 · inmutabilidad del payload (G3)", () => {
  it("la base rechaza cambiar el texto de un saliente; los estados sí se actualizan", async () => {
    await startOfferTurn();
    const out = (await settle()).messages.find((m) => m.direction === "out")!;
    const { getDb } = await import("@/lib/db");
    const { sql } = await import("drizzle-orm");
    await expect(
      getDb().execute(sql`update message set text = 'otro texto' where id = ${out.id}`)
    ).rejects.toThrow();
    await getDb().execute(sql`update message set status = 'delivered' where id = ${out.id}`);
    expect((await outboundRows())[0]!.text).toBe(FULL_MESSAGE);
  });
});

describe("12 · sandbox del Laboratorio", () => {
  it("una conversación de prueba jamás llega a Meta: ni el turno, ni un intento del outbox", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const organizationId = await orgId();
    const db = getDb();
    const contactId = newId("contact");
    await db.insert(schema.contact).values({
      id: contactId,
      organizationId,
      waIdentity: "lab:sandbox-1",
      name: "Persona de prueba",
    });
    const conversationId = newId("conversation");
    await db.insert(schema.conversation).values({
      id: conversationId,
      organizationId,
      contactId,
      isTest: true,
    });
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId,
      direction: "in",
      type: "text",
      text: "quiero agendar",
      status: "delivered",
    });

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn(conversationId);

    const out = (await outboundRows()).filter((m) => m.conversationId === conversationId);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("sent");
    expect(harness.meta.calls).toHaveLength(0); // jamás tocó la API
    const offers = (await snapshot()).offers.filter((o) => o.conversationId === conversationId);
    expect(offers.every((o) => o.state === "active")).toBe(true);

    // Y aunque alguien encolara un mensaje de prueba, el intento lo frena.
    const { enqueueText, attemptDelivery } = await import("@/server/outbox");
    const { message } = await enqueueText({
      organizationId,
      conversationId,
      text: "no debe salir",
      origin: "ai",
      aiGenerated: true,
    });
    const outcome = await attemptDelivery(message.id);
    expect(outcome.claimed && outcome.outcome).toBe("failed");
    expect(harness.meta.calls).toHaveLength(0);
  });
});
