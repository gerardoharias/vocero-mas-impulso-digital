import { asc, eq, sql } from "drizzle-orm";
import { harness, type MetaCall } from "../setup";
import { createTestDatabase, type TestDatabase } from "./db";

/**
 * Escenario de extremo a extremo sobre el código real: un inbound de WhatsApp
 * entra por `processMessagesValue` (lo mismo que hace la ruta del webhook),
 * cruza la ingesta idempotente y el coalesce, corre el pipeline del agente y
 * llega a Meta (simulado). Sin datos personales: teléfonos y nombres ficticios.
 */

export const PHONE_NUMBER_ID = "PNID_IT_1";
export const PROSPECT_WA_ID = "5215500000001";

let testDb: TestDatabase | null = null;
export let organizationId = "";

export async function bootScenario(): Promise<void> {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/db/ids");
  const { saveCredentials } = await import("@/server/whatsapp/credentials");
  const db = getDb();

  organizationId = newId("organization");
  await db.insert(schema.organization).values({
    id: organizationId,
    name: "Org de integración",
    slug: `it-${organizationId}`,
  });
  await db.insert(schema.agentProfile).values({
    id: newId("agentProfile"),
    organizationId,
    enabled: true,
    name: "Max",
  });
  await db.insert(schema.pipelineStage).values({
    id: newId("stage"),
    organizationId,
    name: "Nuevo",
    position: 0,
    kind: "open",
  });
  await saveCredentials({
    organizationId,
    wabaId: "WABA_IT_1",
    phoneNumberId: PHONE_NUMBER_ID,
    token: "EAAG-TOKEN-DE-PRUEBA-NO-REAL-123456",
    displayPhoneNumber: "5215500000000",
  });
  // Igual que `instrumentation-node.ts` en producción: el trabajador del outbox
  // corre de fondo (sondeo + temporizador puntual por reintento).
  const { startOutboxWorker } = await import("@/server/outbox");
  startOutboxWorker();
}

export async function teardownScenario(): Promise<void> {
  try {
    const { stopOutboxWorker } = await import("@/server/outbox");
    stopOutboxWorker();
  } catch {
    /* ya detenido */
  }
  try {
    const { getSql } = await import("@/lib/db");
    await getSql().end({ timeout: 2 });
  } catch {
    /* la conexión ya estaba cerrada */
  }
  await testDb?.drop();
  testDb = null;
}

/**
 * Deja la base sin conversaciones (conserva organización, credenciales, perfil
 * y etapas): cada prueba parte de cero sin recrear la base entera.
 */
export async function resetData(): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const { startOutboxWorker, stopOutboxWorker } = await import("@/server/outbox");
  // TRUNCATE pide un candado exclusivo: contra el sondeo de fondo del outbox (que
  // toma candados de fila sobre `message`) puede caer en un DEADLOCK (40P01). Se
  // detiene el sondeo mientras se limpia y, por si un barrido ya en curso todavía
  // sostiene algo, se reintenta ante deadlock/timeout de candado. Sólo del arnés:
  // producción jamás trunca.
  stopOutboxWorker();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await getDb().execute(
          sql`TRUNCATE contact, conversation, message, offered_slot, booking, calendar_settings CASCADE`
        );
        break;
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
        if ((code === "40P01" || code === "55P03") && attempt < 8) {
          await new Promise((r) => setTimeout(r, 50 * attempt));
          continue;
        }
        throw err;
      }
    }
  } finally {
    startOutboxWorker();
  }
  const g = globalThis as { __agentCoalesce?: Map<string, unknown> };
  g.__agentCoalesce?.clear();
}

let inboundSeq = 0;

/** Entrega un mensaje entrante por el mismo camino que el webhook real. */
export async function deliverInbound(input: {
  text: string;
  wamid?: string;
  /** Segundos epoch; por omisión, ahora (ventana de 24 h abierta). */
  timestamp?: number;
  from?: string;
}): Promise<{ wamid: string }> {
  const { processMessagesValue } = await import("@/server/inbox/ingest");
  const wamid = input.wamid ?? `wamid.IN.${++inboundSeq}`;
  const from = input.from ?? PROSPECT_WA_ID;
  await processMessagesValue({
    messaging_product: "whatsapp",
    metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: "5215500000000" },
    contacts: [{ profile: { name: "Prospecto de prueba" }, wa_id: from }],
    messages: [
      {
        from,
        id: wamid,
        timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: input.text },
      },
    ],
  });
  return { wamid };
}

const IN_FLIGHT = new Set(["queued", "sending", "retrying"]);

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Espera a que el turno del agente termine y ningún saliente siga en vuelo. */
export async function settle(opts?: { timeoutMs?: number }): Promise<Snapshot> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
  let stable = 0;
  for (;;) {
    const coalesce = (globalThis as { __agentCoalesce?: Map<string, unknown> })
      .__agentCoalesce;
    const idle = !coalesce || coalesce.size === 0;
    const snap = await snapshot();
    const inFlight = snap.messages.some(
      (m) => m.direction === "out" && IN_FLIGHT.has(m.status)
    );
    if (idle && !inFlight) {
      if (++stable >= 4) return snap;
    } else {
      stable = 0;
    }
    if (Date.now() > deadline) return snap;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function snapshot() {
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  const messages = await db
    .select()
    .from(schema.message)
    .orderBy(asc(schema.message.createdAt), asc(schema.message.id));
  const offers = await db.select().from(schema.offeredSlot);
  const conversations = await db.select().from(schema.conversation);
  const bookings = await db.select({ id: schema.booking.id }).from(schema.booking);

  // La tabla de intentos existe sólo tras la migración 0023 (spec 024).
  const reg = (await db.execute(
    sql`select to_regclass('public.message_delivery_attempt') as t`
  )) as unknown as { t: string | null }[];
  let attempts: Record<string, unknown>[] | null = null;
  if (reg[0]?.t) {
    attempts = (await db.execute(
      sql`select * from message_delivery_attempt order by message_id, attempt_no`
    )) as unknown as Record<string, unknown>[];
  }
  return { messages, offers, conversations, bookings, attempts };
}

/** Acuse de estado de Meta (`statuses[]`), por el mismo camino que el webhook. */
export async function deliverStatus(input: {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  code?: number;
  title?: string;
}): Promise<void> {
  const { processMessagesValue } = await import("@/server/inbox/ingest");
  await processMessagesValue({
    messaging_product: "whatsapp",
    metadata: { phone_number_id: PHONE_NUMBER_ID },
    statuses: [
      {
        id: input.wamid,
        status: input.status,
        timestamp: String(Math.floor(Date.now() / 1000)),
        errors:
          input.status === "failed"
            ? [{ code: input.code ?? 0, title: input.title ?? "Meta error" }]
            : undefined,
      },
    ],
  });
}

/** Espera una condición observable en la base (nunca un sleep fijo a ciegas). */
export async function waitUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; label?: string } = {}
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: se agotó el tiempo (${opts.label ?? "condición"})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function outboundRows() {
  const snap = await snapshot();
  return snap.messages.filter((m) => m.direction === "out");
}

export async function conversationRow() {
  const { getDb, schema } = await import("@/lib/db");
  const rows = await getDb().select().from(schema.conversation).limit(1);
  return rows[0]!;
}

export async function updateConversation(set: Record<string, unknown>) {
  const { getDb, schema } = await import("@/lib/db");
  const c = await conversationRow();
  await getDb().update(schema.conversation).set(set).where(eq(schema.conversation.id, c.id));
}

/** Cuerpos de texto que llegaron a Meta, en orden de intento. */
export function sentBodies(): string[] {
  return harness.meta.calls.map((c) => c.text ?? "");
}

/** Traza legible y SIN datos personales del escenario (Fase 1 §4). */
export function traceOf(snap: Snapshot, extra: Record<string, unknown> = {}) {
  const out = snap.messages.filter((m) => m.direction === "out");
  const inbound = snap.messages.filter((m) => m.direction === "in");
  return {
    pipelineRuns: harness.counts.pipelineRuns,
    aiCalls: harness.ai.calls,
    availabilityQueries: harness.availability.calls,
    offerSlotsExecutions: harness.counts.offerSlots,
    bookSlotExecutions: harness.counts.bookSlot,
    inboundEventIds: inbound.map((m) => m.waMessageId),
    outboundMessageRows: out.map((m) => ({
      id: m.id,
      status: m.status,
      wamid: m.waMessageId,
      error: m.error,
      textLines: (m.text ?? "").split("\n").length,
    })),
    attemptRows: snap.attempts
      ? snap.attempts.map((a) => ({
          message: a.message_id,
          attempt: a.attempt_no,
          outcome: a.outcome,
          metaCode: a.meta_code,
          wamid: a.wamid,
        }))
      : "(sin tabla de intentos: no existe outbox)",
    offeredSlotRows: snap.offers.length,
    handoffs: snap.conversations.filter((c) => c.handoffAt).length,
    metaAttempts: harness.meta.calls.map((c: MetaCall) => ({
      attempt: c.n,
      outcome: c.outcome,
      lines: (c.text ?? "").split("\n").length,
      body: c.text,
    })),
    ...extra,
  };
}
