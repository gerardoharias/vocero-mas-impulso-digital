import { and, asc, eq, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { describeSendError } from "@/lib/meta/send-errors";
import { capabilitiesFor } from "@/server/channels/capabilities";
import { publish } from "@/server/events/bus";
import { serializeMessage } from "@/server/inbox/ingest";
import {
  deliverText,
  prepareSend,
  SendError,
  type SendTarget,
} from "@/server/inbox/send";
import {
  activateOffers,
  insertPendingOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  checkOfferFreshness,
  markOfferStale,
  staleMessage,
} from "@/server/agenda/offer-freshness";
import {
  classifyFailure,
  hasAttemptsLeft,
  LEASE_MS,
  pollIntervalMs,
  QUEUED_STALE_MS,
  retryDelayMs,
  type Classification,
  type FailureClass,
  type FailureSignal,
} from "@/server/outbox/policy";

/**
 * 024 — Outbox de mensajes salientes de texto.
 *
 * Un MENSAJE LÓGICO es una fila de `message`; su payload final (`text`) se
 * persiste ANTES del primer intento y nunca cambia. Un INTENTO es una fila de
 * `message_delivery_attempt`. Este módulo sólo mueve estados y reenvía
 * `message.text`: NO importa el modelo de IA, el pipeline del agente ni la
 * lógica de agenda (G4, G9, G10), y por eso un reintento no puede llamarlos.
 *
 * Los logs llevan lista blanca (id interno, intento, clase, código de Meta):
 * jamás token, teléfono, texto de la conversación ni cuerpos de Meta (AC-17).
 */

type MessageRow = typeof schema.message.$inferSelect;

/* ------------------------------------------------------------------ */
/* Encolado                                                            */
/* ------------------------------------------------------------------ */

export type EnqueueInput = {
  organizationId: string;
  conversationId: string;
  /** Payload FINAL, tal cual debe llegar al prospecto. */
  text: string;
  origin: "ai" | "operator";
  aiGenerated: boolean;
  /** Una respuesta lógica por clave (`agent-turn:<inbound>`). */
  dedupeKey?: string;
  /** Horarios que este mensaje muestra: nacen `pending`, en la misma transacción. */
  offers?: OfferedSlot[];
  now?: Date;
};

/**
 * Persiste el mensaje (`queued`) con su texto final y, si lo trae, sus horarios
 * `pending`. `created: false` significa que la clave de deduplicación ya existía:
 * es la MISMA respuesta lógica y no se vuelve a enviar.
 */
export async function enqueueText(
  input: EnqueueInput
): Promise<{ message: MessageRow; created: boolean }> {
  const db = getDb();
  const now = input.now ?? new Date();

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.message)
      .values({
        id: newId("message"),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        waMessageId: null,
        direction: "out",
        type: "text",
        text: input.text,
        status: "queued",
        aiGenerated: input.aiGenerated,
        origin: input.origin,
        dedupeKey: input.dedupeKey ?? null,
        // La ronda que este mensaje muestra nace `pending` (spec 024 §5.6).
        offerState: input.offers && input.offers.length > 0 ? "pending" : null,
        traceId: newTraceId(),
        createdAt: now,
      })
      .onConflictDoNothing({ target: [schema.message.dedupeKey] })
      .returning();
    const message = inserted[0];
    if (!message) return null;

    if (input.offers && input.offers.length > 0) {
      await insertPendingOffers(tx, {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        messageId: message.id,
        slots: input.offers,
      });
    }
    await tx
      .update(schema.conversation)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversation.id, input.conversationId));
    return message;
  });

  if (!result) {
    const existing = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.dedupeKey, input.dedupeKey ?? ""))
      .limit(1);
    if (!existing[0]) throw new Error("outbox: clave de deduplicación sin fila");
    return { message: existing[0], created: false };
  }

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(result, null),
    },
  });
  return { message: result, created: true };
}

function newTraceId(): string {
  return `trc_${newId("message").slice(4)}`;
}

/* ------------------------------------------------------------------ */
/* Intento                                                             */
/* ------------------------------------------------------------------ */

export type DeliveryOutcome =
  /** Otro trabajador reclamó el intento (o ya no estaba disponible). */
  | { claimed: false; messageId: string }
  | {
      claimed: true;
      messageId: string;
      attemptNo: number;
      outcome: "pending" | "sent" | "retrying" | "delivery_unknown";
    }
  | {
      claimed: true;
      messageId: string;
      attemptNo: number;
      outcome: "failed";
      class: FailureClass;
      sendError: SendError;
    };

const AMBIGUOUS_COPY =
  "No se pudo confirmar si Meta recibió el mensaje. Revisa la conversación antes de reenviarlo para no duplicarlo.";

const PREFLIGHT_CLASS: Record<SendError["code"], FailureClass> = {
  window_closed: "window_closed",
  reconnect_required: "auth",
  not_connected: "permanent",
  sandbox_violation: "permanent",
  meta_error: "permanent",
  meta_unavailable: "transient",
  upload_failed: "permanent",
  offer_stale: "offer_stale",
  resend_conflict: "permanent",
};

/**
 * Ejecuta UN intento de transporte de un mensaje lógico.
 *
 * 1. RECLAMO atómico (`UPDATE … WHERE status IN (…) RETURNING`): si otro
 *    trabajador lo tiene, no se envía nada (AC-9).
 * 2. Vuelve a pasar el pre-vuelo (sandbox, ventana de 24 h, credenciales) —
 *    salvo que el llamador acabe de hacerlo y pase `target`.
 * 3. Envía `message.text` leído de la base — nunca un texto recalculado (G3).
 * 4. Clasifica el resultado con la política y mueve el estado.
 *
 * `manual`: reenvío del operador sobre `failed`/`delivery_unknown`; un intento y
 * sin reintentos automáticos posteriores.
 */
export async function attemptDelivery(
  messageId: string,
  opts: { now?: Date; target?: SendTarget; manual?: boolean } = {}
): Promise<DeliveryOutcome> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const manual = opts.manual === true;

  const claimable = manual
    ? inArray(schema.message.status, ["failed", "delivery_unknown"])
    : or(
        eq(schema.message.status, "queued"),
        and(
          eq(schema.message.status, "retrying"),
          lte(schema.message.nextAttemptAt, now)
        )
      );

  const claimed = await db
    .update(schema.message)
    .set({
      status: "sending",
      deliveryAttempts: sql`${schema.message.deliveryAttempts} + 1`,
      lockedUntil: new Date(now.getTime() + LEASE_MS),
      nextAttemptAt: null,
    })
    .where(
      and(
        eq(schema.message.id, messageId),
        eq(schema.message.direction, "out"),
        eq(schema.message.type, "text"),
        claimable
      )
    )
    .returning();
  const row = claimed[0];
  if (!row || row.text === null) return { claimed: false, messageId };

  const attemptNo = row.deliveryAttempts;
  await db.insert(schema.messageDeliveryAttempt).values({
    id: newId("deliveryAttempt"),
    organizationId: row.organizationId,
    messageId: row.id,
    attemptNo,
    stage: "sync",
    outcome: "started",
    traceId: row.traceId,
    startedAt: now,
  });
  publishStatus(row, "sending", null);

  // Reintento AUTOMÁTICO (no es el intento inline recién armado ni un reenvío
  // manual, que ya pasó su propio guard): si el mensaje ofrecía horarios, se
  // revalida ANTES de enviar. `pending` no reserva nada: en el backoff otro
  // prospecto pudo ocupar un hueco, y el texto es inmutable (no se puede quitar
  // ese horario). Lo que el sistema ya sabe que no está libre NO se ofrece.
  let target = opts.target;
  try {
    if (!target && !manual) {
      const fresh = await checkOfferFreshness(row.id, { now });
      if (fresh.applies && !fresh.ok) {
        return failStale(row, attemptNo, fresh.reason, now);
      }
    }
    target ??= await prepareSend(row.conversationId, row.organizationId);
  } catch (err) {
    return failPreflight(row, attemptNo, err, now);
  }

  let wamid: string;
  try {
    // El texto sale de la BASE, no de un argumento: G3.
    wamid = await deliverText(target, row.text);
  } catch (err) {
    return settleFailure(row, attemptNo, err, target, { now, manual });
  }
  return settleAccepted(row, attemptNo, wamid, target, now);
}

/** Meta aceptó: hay `wamid`. Activa los horarios que este mensaje muestra. */
async function settleAccepted(
  row: MessageRow,
  attemptNo: number,
  wamid: string,
  target: SendTarget,
  now: Date
): Promise<DeliveryOutcome> {
  const db = getDb();
  // Un canal sin acuses de entrega confirma al aceptar; uno con acuses avanza
  // después por webhook. Sin esta distinción el mensaje se queda con el reloj
  // puesto para siempre.
  const status = capabilitiesFor(target.conversation.channel).deliveryReceipts
    ? "pending"
    : "sent";
  const updated = await db
    .update(schema.message)
    .set({
      status,
      waMessageId: wamid,
      lockedUntil: null,
      nextAttemptAt: null,
      error: null,
      errorCode: null,
      errorSubcode: null,
      errorClass: null,
    })
    .where(and(eq(schema.message.id, row.id), eq(schema.message.status, "sending")))
    .returning({ id: schema.message.id });
  await closeAttempt(row, attemptNo, {
    outcome: "accepted",
    wamid,
    finishedAt: now,
  });
  if (updated.length === 0) {
    // El intento fue dado por huérfano mientras estaba en vuelo: Meta SÍ lo
    // aceptó. Se reconcilia por el wamid (no se pierde la evidencia).
    await db
      .update(schema.message)
      .set({ status, waMessageId: wamid, lockedUntil: null, error: null })
      .where(
        and(
          eq(schema.message.id, row.id),
          inArray(schema.message.status, ["delivery_unknown", "failed"])
        )
      );
  }
  await activateOffers(row.id).catch((err) => {
    console.error(`[outbox] no se pudieron activar los horarios de ${row.id}: ${errName(err)}`);
  });
  publishStatus(row, status, null);
  log("accepted", row, attemptNo);
  return { claimed: true, messageId: row.id, attemptNo, outcome: status };
}

/**
 * La oferta de horarios dejó de ser vigente antes del reintento: NO se envía
 * (ni completa ni parcial). Queda `failed` con el payload íntegro; la ronda se
 * marca obsoleta y el operador ve que debe generar una nueva.
 */
async function failStale(
  row: MessageRow,
  attemptNo: number,
  reason: Parameters<typeof staleMessage>[0],
  now: Date
): Promise<DeliveryOutcome> {
  await markOfferStale(row.id);
  const sendError = new SendError("offer_stale", staleMessage(reason));
  return finalizeFailed(
    row,
    attemptNo,
    "offer_stale",
    sendError.message,
    sendError,
    null,
    now,
    { outcome: "permanent_failure" }
  );
}

/** Un fallo ANTES de tocar Meta (pre-vuelo del intento): no hubo envío. */
async function failPreflight(
  row: MessageRow,
  attemptNo: number,
  err: unknown,
  now: Date
): Promise<DeliveryOutcome> {
  const sendError =
    err instanceof SendError
      ? err
      : new SendError("meta_unavailable", "No se pudo preparar el envío");
  const cls = PREFLIGHT_CLASS[sendError.code];
  // Un error inesperado antes de salir hacia Meta es pasajero (la BD, no Meta):
  // se reintenta dentro del presupuesto. Los demás ya tienen su desenlace.
  const retryable = !(err instanceof SendError) && hasAttemptsLeft(attemptNo);
  if (retryable) {
    return scheduleRetry(row, attemptNo, "transient", sendError.message, null, null, now, {
      outcome: "transient_failure",
    });
  }
  return finalizeFailed(row, attemptNo, cls, sendError.message, sendError, null, now, {
    outcome: "permanent_failure",
  });
}

/** El transporte falló: la política decide reintentar, esperar evidencia o cerrar. */
async function settleFailure(
  row: MessageRow,
  attemptNo: number,
  err: unknown,
  target: SendTarget,
  ctx: { now: Date; manual: boolean }
): Promise<DeliveryOutcome> {
  const sendError =
    err instanceof SendError
      ? err
      : new SendError("meta_error", "No se pudo enviar el mensaje");
  const transport = sendError.transport ?? null;

  // Sólo WhatsApp tiene la tabla de códigos de Meta; los demás canales (Zernio)
  // no reintentan: cualquier fallo es definitivo, como antes de 024.
  const isWhatsapp = target.credentials !== null;
  const classification: Classification = isWhatsapp
    ? classifyFailure(signalOf(sendError, transport))
    : { class: "permanent", retryable: false, ambiguous: false };

  const code = transport?.code ?? null;
  const subcode = transport?.subcode ?? null;
  const http = transport?.httpStatus ?? null;
  const detail = { code, subcode, http };

  if (classification.ambiguous) {
    return finalizeUnknown(row, attemptNo, detail, ctx.now);
  }
  if (classification.retryable && !ctx.manual && hasAttemptsLeft(attemptNo)) {
    return scheduleRetry(
      row,
      attemptNo,
      classification.class as "transient" | "rate_limit",
      sendError.message,
      code,
      subcode,
      ctx.now,
      {
        outcome:
          classification.class === "rate_limit" ? "rate_limited" : "transient_failure",
        http,
      }
    );
  }
  return finalizeFailed(
    row,
    attemptNo,
    classification.class,
    sendError.message,
    sendError,
    detail,
    ctx.now,
    {
      outcome: classification.retryable ? "transient_failure" : "permanent_failure",
    }
  );
}

function signalOf(
  err: SendError,
  t: SendError["transport"] | null
): FailureSignal {
  if (!t) {
    // Sin detalle de transporte (p. ej. `reconnect_required` ya traducido).
    return {
      stage: "sync",
      code: err.code === "reconnect_required" ? 190 : null,
      httpStatus: err.code === "reconnect_required" ? 401 : null,
      network: "unknown",
    };
  }
  return {
    stage: "sync",
    code: t.code,
    subcode: t.subcode,
    httpStatus: t.httpStatus,
    network: t.network,
    noMessageId: t.noMessageId,
  };
}

type AttemptDetail = {
  code: number | null;
  subcode: number | null;
  http: number | null;
};

async function scheduleRetry(
  row: MessageRow,
  attemptNo: number,
  cls: "transient" | "rate_limit",
  errorText: string,
  code: number | null,
  subcode: number | null,
  now: Date,
  attempt: { outcome: "transient_failure" | "rate_limited"; http?: number | null }
): Promise<DeliveryOutcome> {
  const db = getDb();
  const delay = retryDelayMs(cls, attemptNo);
  const next = new Date(now.getTime() + delay);
  await db
    .update(schema.message)
    .set({
      status: "retrying",
      nextAttemptAt: next,
      lockedUntil: null,
      error: errorText,
      errorCode: code,
      errorSubcode: subcode,
      errorClass: cls,
    })
    .where(and(eq(schema.message.id, row.id), eq(schema.message.status, "sending")));
  await closeAttempt(row, attemptNo, {
    outcome: attempt.outcome,
    errorClass: cls,
    metaCode: code,
    metaSubcode: subcode,
    httpStatus: attempt.http ?? null,
    finishedAt: now,
  });
  publishStatus(row, "retrying", errorText);
  log("retrying", row, attemptNo, { cls, code, delayMs: delay });
  scheduleKick(delay);
  return { claimed: true, messageId: row.id, attemptNo, outcome: "retrying" };
}

async function finalizeFailed(
  row: MessageRow,
  attemptNo: number,
  cls: FailureClass,
  errorText: string,
  sendError: SendError,
  detail: AttemptDetail | null,
  now: Date,
  attempt: { outcome: "permanent_failure" | "transient_failure" }
): Promise<DeliveryOutcome> {
  const db = getDb();
  await db
    .update(schema.message)
    .set({
      status: "failed",
      lockedUntil: null,
      nextAttemptAt: null,
      error: errorText,
      errorCode: detail?.code ?? null,
      errorSubcode: detail?.subcode ?? null,
      errorClass: cls,
    })
    .where(and(eq(schema.message.id, row.id), eq(schema.message.status, "sending")));
  await closeAttempt(row, attemptNo, {
    outcome: attempt.outcome,
    errorClass: cls,
    metaCode: detail?.code ?? null,
    metaSubcode: detail?.subcode ?? null,
    httpStatus: detail?.http ?? null,
    finishedAt: now,
  });
  publishStatus(row, "failed", errorText);
  log("failed", row, attemptNo, { cls, code: detail?.code ?? null });
  return {
    claimed: true,
    messageId: row.id,
    attemptNo,
    outcome: "failed",
    class: cls,
    sendError,
  };
}

async function finalizeUnknown(
  row: MessageRow,
  attemptNo: number,
  detail: AttemptDetail,
  now: Date
): Promise<DeliveryOutcome> {
  const db = getDb();
  await db
    .update(schema.message)
    .set({
      status: "delivery_unknown",
      lockedUntil: null,
      nextAttemptAt: null,
      error: AMBIGUOUS_COPY,
      errorCode: detail.code,
      errorSubcode: detail.subcode,
      errorClass: "ambiguous",
    })
    .where(and(eq(schema.message.id, row.id), eq(schema.message.status, "sending")));
  await closeAttempt(row, attemptNo, {
    outcome: "ambiguous",
    errorClass: "ambiguous",
    metaCode: detail.code,
    metaSubcode: detail.subcode,
    httpStatus: detail.http,
    finishedAt: now,
  });
  publishStatus(row, "delivery_unknown", AMBIGUOUS_COPY);
  log("delivery_unknown", row, attemptNo, { code: detail.code });
  return {
    claimed: true,
    messageId: row.id,
    attemptNo,
    outcome: "delivery_unknown",
  };
}

async function closeAttempt(
  row: Pick<MessageRow, "id">,
  attemptNo: number,
  set: Partial<typeof schema.messageDeliveryAttempt.$inferInsert>
): Promise<void> {
  try {
    await getDb()
      .update(schema.messageDeliveryAttempt)
      .set(set)
      .where(
        and(
          eq(schema.messageDeliveryAttempt.messageId, row.id),
          eq(schema.messageDeliveryAttempt.attemptNo, attemptNo)
        )
      );
  } catch (err) {
    // El historial es auditoría: nunca debe tumbar la entrega.
    console.error(`[outbox] no se pudo cerrar el intento ${row.id}#${attemptNo}: ${errName(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Fallo ASÍNCRONO (webhook de estado)                                 */
/* ------------------------------------------------------------------ */

/**
 * Meta aceptó el mensaje (hay `wamid`) y luego avisó `failed`. Declara que NO
 * lo entregó, así que reenviar es seguro cuando el código es reintentable. Se
 * actualiza el MISMO mensaje: la burbuja no se duplica (G6).
 */
export async function applyAsyncFailure(input: {
  message: Pick<
    MessageRow,
    "id" | "organizationId" | "conversationId" | "status" | "deliveryAttempts" | "traceId"
  >;
  code: number | null;
  subcode?: number | null;
  detail?: string | null;
  now?: Date;
}): Promise<{ status: "retrying" | "failed"; error: string }> {
  const db = getDb();
  const now = input.now ?? new Date();
  const { message } = input;
  const cls = classifyFailure({
    stage: "async",
    code: input.code,
    subcode: input.subcode,
  });
  const error = describeSendError(input.code, input.detail);
  const attemptNo = message.deliveryAttempts;

  const canRetry =
    cls.retryable &&
    hasAttemptsLeft(attemptNo) &&
    (message.status === "pending" || message.status === "sent");

  const attemptSet = {
    stage: "async" as const,
    outcome: "async_failed" as const,
    errorClass: cls.class,
    metaCode: input.code,
    metaSubcode: input.subcode ?? null,
    finishedAt: now,
  };

  if (canRetry) {
    const delay = retryDelayMs(cls.class as "transient" | "rate_limit", attemptNo);
    const moved = await db
      .update(schema.message)
      .set({
        status: "retrying",
        // El wamid viejo queda en el intento: los acuses tardíos de ese
        // identificador ya no corresponden a este mensaje.
        waMessageId: null,
        nextAttemptAt: new Date(now.getTime() + delay),
        lockedUntil: null,
        error,
        errorCode: input.code,
        errorSubcode: input.subcode ?? null,
        errorClass: cls.class,
      })
      .where(
        and(
          eq(schema.message.id, message.id),
          inArray(schema.message.status, ["pending", "sent"])
        )
      )
      .returning({ id: schema.message.id });
    if (moved.length > 0) {
      await closeAttempt(message, attemptNo, attemptSet);
      log("retrying", message, attemptNo, { cls: cls.class, code: input.code, delayMs: delay, stage: "async" });
      scheduleKick(delay);
      return { status: "retrying", error };
    }
  }

  await db
    .update(schema.message)
    .set({
      status: "failed",
      error,
      errorCode: input.code,
      errorSubcode: input.subcode ?? null,
      errorClass: cls.class,
      lockedUntil: null,
      nextAttemptAt: null,
    })
    .where(eq(schema.message.id, message.id));
  await closeAttempt(message, attemptNo, attemptSet);
  log("failed", message, attemptNo, { cls: cls.class, code: input.code, stage: "async" });
  return { status: "failed", error };
}

/* ------------------------------------------------------------------ */
/* Trabajador                                                          */
/* ------------------------------------------------------------------ */

/**
 * Un barrido: 1) cierra los intentos HUÉRFANOS (el proceso murió con el envío
 * en vuelo: Meta pudo haberlo aceptado ⇒ `delivery_unknown`, jamás un reenvío
 * a ciegas), 2) reclama lo vencido y reintenta su payload persistido.
 *
 * Seguro con varios procesos/trabajadores: cada intento se reclama con un
 * UPDATE atómico.
 */
export async function runDueDeliveries(
  opts: { now?: Date; limit?: number } = {}
): Promise<number> {
  const db = getDb();
  const now = opts.now ?? new Date();

  await recoverOrphans(now);

  const due = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.direction, "out"),
        or(
          and(
            eq(schema.message.status, "retrying"),
            lte(schema.message.nextAttemptAt, now)
          ),
          // Nunca se intentó (el proceso cayó entre persistir y enviar): es
          // seguro enviarlo, no hubo ningún intento previo.
          and(
            eq(schema.message.status, "queued"),
            lt(schema.message.createdAt, new Date(now.getTime() - QUEUED_STALE_MS))
          )
        )
      )
    )
    .orderBy(asc(schema.message.nextAttemptAt))
    .limit(opts.limit ?? 25);

  let attempted = 0;
  for (const { id } of due) {
    try {
      const out = await attemptDelivery(id, { now });
      if (out.claimed) attempted++;
    } catch (err) {
      console.error(`[outbox] el intento de ${id} lanzó: ${errName(err)}`);
    }
  }
  return attempted;
}

async function recoverOrphans(now: Date): Promise<void> {
  const db = getDb();
  const orphans = await db
    .update(schema.message)
    .set({
      status: "delivery_unknown",
      lockedUntil: null,
      nextAttemptAt: null,
      error: AMBIGUOUS_COPY,
      errorClass: "ambiguous",
    })
    .where(
      and(
        eq(schema.message.status, "sending"),
        isNotNull(schema.message.lockedUntil),
        lt(schema.message.lockedUntil, now)
      )
    )
    .returning();
  for (const row of orphans) {
    await db
      .update(schema.messageDeliveryAttempt)
      .set({ outcome: "abandoned", errorClass: "ambiguous", finishedAt: now })
      .where(
        and(
          eq(schema.messageDeliveryAttempt.messageId, row.id),
          eq(schema.messageDeliveryAttempt.outcome, "started")
        )
      );
    publishStatus(row, "delivery_unknown", AMBIGUOUS_COPY);
    log("orphan_unknown", row, row.deliveryAttempts);
  }
}

type WorkerGlobals = {
  __outboxWorker?: ReturnType<typeof setInterval>;
  __outboxTicking?: boolean;
  __outboxAgain?: boolean;
};
const wg = globalThis as unknown as WorkerGlobals;

/**
 * Un barrido a la vez por proceso. Si se pide otro mientras corre uno (un
 * temporizador puntual que vence en medio), NO se descarta: se repite al
 * terminar. Descartarlo dejaba un reintento esperando al siguiente sondeo.
 */
async function tick(): Promise<void> {
  if (wg.__outboxTicking) {
    wg.__outboxAgain = true;
    return;
  }
  wg.__outboxTicking = true;
  try {
    do {
      wg.__outboxAgain = false;
      try {
        await runDueDeliveries();
      } catch (err) {
        console.error(`[outbox] barrido falló: ${errName(err)}`);
      }
    } while (wg.__outboxAgain);
  } finally {
    wg.__outboxTicking = false;
  }
}

/** Temporizador puntual: el reintento sale a su hora sin esperar al siguiente barrido. */
function scheduleKick(delayMs: number): void {
  const t = setTimeout(() => void tick(), delayMs + 25);
  t.unref?.();
}

/** Idempotente: el hot-reload de Next en dev puede reimportar el módulo. */
export function startOutboxWorker(): void {
  if (wg.__outboxWorker) return;
  // Una línea al arrancar (una sola por proceso): el runbook la usa para
  // comprobar que el trabajador está vivo. Sin datos de nadie.
  console.log(`[outbox] trabajador iniciado (sondeo cada ${pollIntervalMs()} ms)`);
  const timer = setInterval(() => void tick(), pollIntervalMs());
  timer.unref?.();
  wg.__outboxWorker = timer;
  void tick();
}

/** Para pruebas: simula la muerte del proceso (los datos persistidos siguen). */
export function stopOutboxWorker(): void {
  if (wg.__outboxWorker) clearInterval(wg.__outboxWorker);
  wg.__outboxWorker = undefined;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function publishStatus(
  row: Pick<MessageRow, "organizationId" | "conversationId" | "id">,
  status: string,
  error: string | null
): void {
  publish(row.organizationId, {
    type: "message.status",
    data: {
      conversationId: row.conversationId,
      messageId: row.id,
      status,
      error,
    },
  });
}

/** Sólo nombre de error: el mensaje de un error de BD o de Meta puede llevar datos. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

/** Log operativo por lista blanca (AC-17): nunca contenido, teléfono ni token. */
function log(
  event: string,
  row: Pick<MessageRow, "id" | "traceId">,
  attemptNo: number,
  extra: Record<string, string | number | null> = {}
): void {
  const parts = [
    `[outbox] ${event}`,
    `msg=${row.id}`,
    `trace=${row.traceId ?? "-"}`,
    `attempt=${attemptNo}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v ?? "-"}`),
  ];
  console.log(parts.join(" "));
}
