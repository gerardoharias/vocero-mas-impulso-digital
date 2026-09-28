import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, INCIDENT_INTRO } from "./setup";
import {
  bootScenario,
  conversationRow,
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
 * Spec 024 §5.6 — reenvío de OFERTAS de horarios y semántica de `pending`.
 *
 *  - Una oferta fallida sólo se reenvía a mano si es la ronda vigente y sus
 *    horarios siguen libres; si no, NO sale nada (ni parcial) y no cambia nada.
 *  - `pending` NO reserva disponibilidad: si otro prospecto ocupa el hueco
 *    durante el backoff, el reintento automático tampoco envía la oferta.
 */

const FULL = [
  INCIDENT_INTRO,
  "• lunes, 21 de septiembre a las 09:00",
  "• martes, 22 de septiembre a las 09:00",
  "• miércoles, 23 de septiembre a las 09:00",
].join("\n");

const PERMANENT = { ok: false, status: 400, code: 131026 } as const;
const T503 = { ok: false, status: 503, code: 2 } as const;

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

/** Una oferta que Meta rechazó de forma definitiva: `failed`, horarios `pending`. */
async function failedOffer() {
  harness.meta.script.push(PERMANENT);
  await deliverInbound({ text: "Sí, quiero agendar", timestamp: nowSec() });
  const snap = await settle();
  const msg = snap.messages.find((m) => m.direction === "out")!;
  expect(msg.status).toBe("failed");
  expect(msg.offerState).toBe("pending");
  expect(msg.text).toBe(FULL);
  return msg;
}

async function resend(messageId: string, organization?: string) {
  const { resendText } = await import("@/server/inbox/send");
  return resendText({ messageId, organizationId: organization ?? (await orgId()) });
}

/** Lo que el bloqueo NO puede tocar: la ronda vigente y los mensajes. */
async function fingerprint() {
  const s = await snapshot();
  return JSON.stringify({
    offers: s.offers.map((o) => [o.id, o.messageId, o.state, o.startUtc]).sort(),
    messages: s.messages.map((m) => [m.id, m.status, m.offerState, m.deliveryAttempts]).sort(),
    attempts: (s.attempts ?? []).map((a) => [a.message_id, a.attempt_no]),
  });
}

describe("reenvío manual de una oferta fallida", () => {
  it("SIN ronda posterior y todavía válida: se permite, con el payload ORIGINAL exacto", async () => {
    const failed = await failedOffer();
    const before = { ai: harness.ai.calls, offer: harness.counts.offerSlots, runs: harness.counts.pipelineRuns };

    const res = await resend(failed.id);

    expect(res.status).toBe("pending");
    expect(sentBodies()).toEqual([FULL, FULL]); // idéntico, íntegro
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(failed.id);
    // Los horarios pasan a ser la ronda vigente.
    const snap = await snapshot();
    expect(out[0]!.offerState).toBe("active");
    expect(snap.offers.every((o) => o.state === "active" && o.messageId === failed.id)).toBe(true);
    // Sin IA, sin pipeline y sin volver a ejecutar offer_slots.
    expect(harness.ai.calls).toBe(before.ai);
    expect(harness.counts.offerSlots).toBe(before.offer);
    expect(harness.counts.pipelineRuns).toBe(before.runs);
  });

  it("un mensaje que NO es oferta se reenvía como siempre (el guard no lo toca)", async () => {
    const { enqueueText, attemptDelivery } = await import("@/server/outbox");
    await failedOffer();
    const conv = await conversationRow();
    const { message } = await enqueueText({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      text: "Texto normal del operador",
      origin: "operator",
      aiGenerated: false,
    });
    harness.meta.script.push(PERMANENT);
    await attemptDelivery(message.id).catch(() => null);
    expect((await outboundRows()).find((m) => m.id === message.id)!.status).toBe("failed");
    const res = await resend(message.id);
    expect(res.status).toBe("pending");
    expect(harness.meta.calls.at(-1)!.text).toBe("Texto normal del operador");
  });

  it("CON una ronda posterior: se bloquea y no cambia la ronda vigente ni crea mensajes", async () => {
    const failed = await failedOffer();
    // El prospecto insiste: el agente arma una ronda NUEVA, que Meta acepta.
    await deliverInbound({ text: "¿tienes otros horarios?", timestamp: nowSec() });
    await settle();
    const rows = await outboundRows();
    expect(rows).toHaveLength(2);
    const second = rows.find((m) => m.id !== failed.id)!;
    expect(second.offerState).toBe("active");

    const before = await fingerprint();
    const calls = harness.meta.calls.length;

    await expect(resend(failed.id)).rejects.toMatchObject({ code: "offer_stale" });

    expect(harness.meta.calls).toHaveLength(calls); // nada salió, ni parcial
    expect(await fingerprint()).toBe(before); // ronda vigente y mensajes intactos
    expect((await outboundRows()).map((m) => m.id).sort()).toEqual([failed.id, second.id].sort());
    // Los horarios seleccionables siguen siendo los de la ronda nueva.
    expect((await snapshot()).offers.every((o) => o.messageId === second.id)).toBe(true);
  });

  it("ronda posterior que TAMBIÉN falló: la primera tampoco se reenvía (conservador)", async () => {
    const failed = await failedOffer();
    harness.meta.script.push(PERMANENT);
    await deliverInbound({ text: "otra vez por favor", timestamp: nowSec() });
    await settle();
    const rows = await outboundRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.status === "failed")).toBe(true);

    const before = await fingerprint();
    const calls = harness.meta.calls.length;
    await expect(resend(failed.id)).rejects.toMatchObject({
      code: "offer_stale",
      message: expect.stringMatching(/ronda de horarios más reciente/),
    });
    expect(harness.meta.calls).toHaveLength(calls);
    expect(await fingerprint()).toBe(before);
  });

  it("con un horario VENCIDO: se bloquea y la ronda queda marcada como obsoleta", async () => {
    const failed = await failedOffer();
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    // El primer horario mostrado pasa al pasado.
    await getDb()
      .update(schema.offeredSlot)
      .set({ startUtc: new Date("2026-09-10T15:00:00Z") })
      .where(eq(schema.offeredSlot.messageId, failed.id));
    const calls = harness.meta.calls.length;

    await expect(resend(failed.id)).rejects.toMatchObject({
      code: "offer_stale",
      message: expect.stringMatching(/venci/),
    });

    expect(harness.meta.calls).toHaveLength(calls);
    expect((await outboundRows())).toHaveLength(1);
    expect((await outboundRows())[0]!.offerState).toBe("superseded");
    // Y una vez obsoleta, sigue bloqueada aunque el motivo desapareciera.
    await expect(resend(failed.id)).rejects.toMatchObject({ code: "offer_stale" });
  });

  it("con un horario OCUPADO (cita o bloqueo activo): se bloquea", async () => {
    const failed = await failedOffer();
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    // Un bloqueo manual que cubre el lunes 09:00 (15:00Z).
    await getDb().insert(schema.booking).values({
      id: newId("booking"),
      organizationId: await orgId(),
      kind: "block",
      scheduledAt: new Date("2026-09-21T15:00:00Z"),
      durationMinutes: 60,
    });
    const calls = harness.meta.calls.length;

    await expect(resend(failed.id)).rejects.toMatchObject({
      code: "offer_stale",
      message: expect.stringMatching(/ocupado/),
    });
    expect(harness.meta.calls).toHaveLength(calls);
    expect((await outboundRows())).toHaveLength(1);
  });

  it("un horario que el motor de disponibilidad YA NO ofrece: se bloquea", async () => {
    const failed = await failedOffer();
    // Disponibilidad de HOY: el martes 09:00 (15:00Z) desapareció.
    harness.availability.slots = harness.availability.slots.filter(
      (s) => s.startUtc !== "2026-09-22T15:00:00.000Z"
    );
    const calls = harness.meta.calls.length;
    await expect(resend(failed.id)).rejects.toMatchObject({
      code: "offer_stale",
      message: expect.stringMatching(/ya no está disponible/),
    });
    expect(harness.meta.calls).toHaveLength(calls);
  });

  it("un horario mostrado que se RESERVÓ (oferta consumida) o fue sustituida: se bloquea", async () => {
    const failed = await failedOffer();
    const { clearOffers } = await import("@/server/agenda/offers");
    await clearOffers(await orgId(), failed.conversationId); // el prospecto reservó
    const calls = harness.meta.calls.length;
    await expect(resend(failed.id)).rejects.toMatchObject({ code: "offer_stale" });
    expect((await outboundRows())[0]!.offerState).toBe("consumed");
    expect(harness.meta.calls).toHaveLength(calls);
  });

  it("el bot/API que arma OTRA ronda (replaceOffers) deja obsoleta la fallida", async () => {
    const failed = await failedOffer();
    const { replaceOffers } = await import("@/server/agenda/offers");
    await replaceOffers(await orgId(), failed.conversationId, [
      { startUtc: "2026-09-25T15:00:00.000Z", label: "vie 25 sep, 09:00" },
    ]);
    await expect(resend(failed.id)).rejects.toMatchObject({ code: "offer_stale" });
    expect((await outboundRows())[0]!.offerState).toBe("superseded");
  });

  it("intento desde OTRA organización: se bloquea y no se toca nada", async () => {
    const failed = await failedOffer();
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const other = newId("organization");
    await getDb().insert(schema.organization).values({ id: other, name: "Otra org", slug: `o-${other}` });
    const before = await fingerprint();
    const calls = harness.meta.calls.length;

    await expect(resend(failed.id, other)).rejects.toThrow(/no encontrado/i);

    expect(harness.meta.calls).toHaveLength(calls);
    expect(await fingerprint()).toBe(before);
  });

  it("un mensaje de OTRA conversación (aunque sea de la misma org) se rechaza", async () => {
    const failed = await failedOffer();
    const { resendText } = await import("@/server/inbox/send");
    await expect(
      resendText({
        messageId: failed.id,
        organizationId: await orgId(),
        conversationId: "cv_otra_conversacion",
      })
    ).rejects.toThrow(/no encontrado/i);
    expect(harness.meta.calls).toHaveLength(1);
  });

  it("estado que NO admite reenvío (ya enviado): se rechaza sin volver a enviar", async () => {
    harness.meta.script.push({ ok: true });
    await deliverInbound({ text: "Sí, quiero agendar", timestamp: nowSec() });
    const snap = await settle();
    const sent = snap.messages.find((m) => m.direction === "out")!;
    expect(sent.status).toBe("pending");
    await expect(resend(sent.id)).rejects.toMatchObject({ code: "resend_conflict" });
    expect(harness.meta.calls).toHaveLength(1);
  });

  it("DOS operadores reenviando a la vez: sólo uno lo hace", async () => {
    const failed = await failedOffer();
    harness.meta.delayMs = 150; // el envío tarda: la carrera es real
    const results = await Promise.allSettled([resend(failed.id), resend(failed.id), resend(failed.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "resend_conflict" });

    expect(harness.meta.calls).toHaveLength(2); // el original + UN reenvío
    expect(sentBodies()).toEqual([FULL, FULL]);
    expect(await outboundRows()).toHaveLength(1);
    const attempts = (await snapshot()).attempts!;
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2]);
  });
});

describe("semántica de `pending`: NO reserva disponibilidad", () => {
  it("los horarios `pending` no son seleccionables ni bloquean a otro prospecto", async () => {
    const failed = await failedOffer();
    const { getOffers } = await import("@/server/agenda/offers");
    expect(await getOffers(await orgId(), failed.conversationId)).toEqual([]);

    // Otro prospecto reserva EL MISMO hueco que la oferta fallida enseñaba.
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { createSessionBooking } = await import("@/server/agenda/service");
    const contactId = newId("contact");
    await getDb().insert(schema.contact).values({
      id: contactId,
      organizationId: await orgId(),
      waIdentity: "5215500000099",
      name: "Otro prospecto",
    });
    const booking = await createSessionBooking({
      organizationId: await orgId(),
      startUtc: "2026-09-21T15:00:00.000Z",
      source: "manual",
      contactId,
      requireOffer: false,
    });
    expect(booking.booking.id).toBeTruthy(); // `pending` no lo impidió
  });

  it("otro prospecto ocupa el hueco durante el BACKOFF: el reintento automático NO envía la oferta", async () => {
    const saved = { b: process.env.OUTBOX_RETRY_BASE_MS, c: process.env.OUTBOX_RETRY_CAP_MS };
    process.env.OUTBOX_RETRY_BASE_MS = "600000";
    process.env.OUTBOX_RETRY_CAP_MS = "600000";
    try {
      harness.meta.script.push(T503, { ok: true });
      await deliverInbound({ text: "Sí, quiero agendar", timestamp: nowSec() });
      const retrying = await waitUntil(
        async () => (await outboundRows()).find((m) => m.status === "retrying"),
        { label: "retrying" }
      );
      expect(harness.meta.calls).toHaveLength(1);

      // Durante la espera, otro prospecto reserva el lunes 09:00.
      const { getDb, schema } = await import("@/lib/db");
      const { newId } = await import("@/lib/db/ids");
      const { createSessionBooking } = await import("@/server/agenda/service");
      const contactId = newId("contact");
      await getDb().insert(schema.contact).values({
        id: contactId,
        organizationId: await orgId(),
        waIdentity: "5215500000098",
        name: "Otro prospecto",
      });
      await createSessionBooking({
        organizationId: await orgId(),
        startUtc: "2026-09-21T15:00:00.000Z",
        source: "manual",
        contactId,
        requireOffer: false,
      });

      // Vence el backoff.
      const { runDueDeliveries } = await import("@/server/outbox");
      await runDueDeliveries({ now: new Date(Date.now() + 20 * 60_000) });

      // El sistema YA SABE que el hueco no está libre: no lo ofrece.
      expect(harness.meta.calls).toHaveLength(1);
      const out = await outboundRows();
      expect(out).toHaveLength(1); // sin fallback, sin introducción sola, sin otro mensaje
      expect(out[0]!.id).toBe(retrying.id);
      expect(out[0]!.status).toBe("failed");
      expect(out[0]!.errorClass).toBe("offer_stale");
      expect(out[0]!.offerState).toBe("superseded");
      expect(out[0]!.text).toBe(FULL); // payload íntegro, conservado
      expect(out[0]!.error).toMatch(/ocupado/);
      expect(out[0]!.error).toMatch(/nueva ronda/);
      // El primero que reservó gana; nada más se creó.
      expect((await snapshot()).bookings).toHaveLength(1);
      expect(harness.ai.calls).toBe(1);
      expect(harness.availability.calls).toBe(1); // el reintento NO consultó el motor
      // Y el reenvío manual sigue vetado.
      await expect(resend(retrying.id)).rejects.toMatchObject({ code: "offer_stale" });
    } finally {
      if (saved.b === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
      else process.env.OUTBOX_RETRY_BASE_MS = saved.b;
      if (saved.c === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
      else process.env.OUTBOX_RETRY_CAP_MS = saved.c;
    }
  });

  it("si nada cambió durante el backoff, el reintento automático envía el payload íntegro", async () => {
    harness.meta.script.push(T503, { ok: true });
    await deliverInbound({ text: "Sí, quiero agendar", timestamp: nowSec() });
    await settle();
    expect(sentBodies()).toEqual([FULL, FULL]);
    expect((await outboundRows())[0]!.offerState).toBe("active");
  });

  it("una oferta fallida NO bloquea indefinidamente: cualquier ronda posterior la reemplaza y limpia", async () => {
    const failed = await failedOffer();
    expect((await snapshot()).offers.every((o) => o.state === "pending")).toBe(true);
    await deliverInbound({ text: "¿otros horarios?", timestamp: nowSec() });
    const snap = await settle();
    const second = snap.messages.filter((m) => m.direction === "out").find((m) => m.id !== failed.id)!;
    // Sólo queda la ronda vigente; las filas `pending` de la fallida se limpiaron.
    expect(snap.offers.every((o) => o.messageId === second.id && o.state === "active")).toBe(true);
    expect(snap.messages.find((m) => m.id === failed.id)!.offerState).toBe("superseded");
  });
});
