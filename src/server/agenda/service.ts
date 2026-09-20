import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { labelInTz } from "@/lib/time/slots";
import { CONNECTOR_META, type ConnectorId } from "@/lib/agenda-connectors";
import {
  computeAvailability,
  findSlot,
  type AvailableSlot,
} from "@/server/agenda/availability";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  clearOffers,
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  bindConnector,
  markConnectorAuthError,
} from "@/server/agenda/connectors";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { publish } from "@/server/events/bus";
import {
  getPendingRescheduleRequest,
  resolvePendingRescheduleRequests,
} from "@/server/agenda/reschedule-requests";

/**
 * 015 — Ciclo de vida de la cita y las dos reglas INNEGOCIABLES:
 *
 *  1. Quien conduce la conversación (agente in-process o cerebro externo) solo
 *     puede reservar un instante que ya se ofreció a ESA conversación
 *     (`offered_slot`, comparación por epoch exacto).
 *  2. Al confirmar se re-valida el hueco y la base lo cierra con su índice
 *     único parcial; si se ocupó, se responde `slot_taken` con alternativas
 *     frescas y NO se crea nada. Nunca se confirma una reserva que no se creó.
 *
 * Y una regla de honestidad: la entrega de la reunión (el conector) corre
 * DESPUÉS de escribir la verdad del CRM y es best-effort. Si el proveedor está
 * caído, la cita se crea igual con el enlace pendiente — un tercero no puede
 * costarnos la conversión, ni hacernos prometer un enlace que no existe.
 */

export type BookingErrorCode =
  | "slot_taken"
  | "slot_not_offered"
  | "not_found"
  | "invalid"
  /**
   * Auditoría 2026-09-17 — el contacto ya tiene una cita activa futura y
   * nadie confirmó EXPLÍCITAMENTE que esta es una reunión aparte.
   */
  | "existing_booking"
  /**
   * Auditoría 2026-09-17 — hay una solicitud de mover la cita todavía
   * pendiente para este contacto (`booking_change_request`). Mientras siga
   * abierta, no se crea ninguna cita nueva sin confirmación explícita: crear
   * una haría exactamente lo que se reportó como bug (dos citas activas).
   */
  | "reschedule_pending";

export class BookingError extends Error {
  code: BookingErrorCode;
  /**
   * Horarios para re-ofrecer. En `slot_taken` son alternativas frescas YA
   * registradas como la nueva oferta de la conversación; en `slot_not_offered`
   * es lo que sí se había ofrecido.
   */
  slots: OfferedSlot[];
  /**
   * En `existing_booking`/`reschedule_pending`: la cita (o el pedido) que
   * bloqueó la creación, para que quien conduce la conversación pueda
   * nombrarla en vez de responder en genérico.
   */
  existing: { bookingId: string; label: string } | null;

  constructor(
    code: BookingErrorCode,
    message: string,
    slots: OfferedSlot[] = [],
    existing: { bookingId: string; label: string } | null = null
  ) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.slots = slots;
    this.existing = existing;
  }
}

type BookingRow = typeof schema.booking.$inferSelect;

export type BookingResult = {
  booking: BookingRow;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

/** Cuántas alternativas se devuelven cuando el hueco se ocupó. */
const FRESH_ALTERNATIVES = 3;

export async function createSessionBooking(input: {
  organizationId: string;
  startUtc: string;
  source: "manual" | "ai";
  /** Obligatoria en el camino conversacional; de ella sale el contacto. */
  conversationId?: string | null;
  /** Camino manual del operador. */
  contactId?: string | null;
  notes?: string | null;
  /**
   * true ⇒ exige que el instante figure entre los ofrecidos a la conversación
   * (agente/bot). El operador elige de la disponibilidad que está viendo, así
   * que reserva sin oferta previa.
   */
  requireOffer: boolean;
  /**
   * Auditoría 2026-09-17 — true SOLO cuando quien conduce la conversación
   * confirmó de forma EXPLÍCITA (nunca inferida del texto) que esta cita es
   * una reunión APARTE de cualquier cita activa que el contacto ya tenga.
   * Con esto en falso (el default) una segunda cita activa para el mismo
   * contacto se bloquea, sin importar el instante que se pida.
   */
  allowAdditional?: boolean;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const settings = await getSettings(input.organizationId);

  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }

  // Contexto de la conversación: contacto y si es del Laboratorio.
  let isTest = false;
  let contactId = input.contactId ?? null;
  let contactName = "";
  if (input.conversationId) {
    const rows = await db
      .select({
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          input.organizationId,
          eq(schema.conversation.id, input.conversationId)
        )
      )
      .limit(1);
    const conv = rows[0];
    if (!conv) throw new BookingError("not_found", "Conversación no encontrada");
    isTest = conv.isTest;
    contactId = contactId ?? conv.contactId;
  }

  if (!contactId) {
    throw new BookingError("invalid", "La cita necesita un contacto");
  }
  contactName = await getContactName(input.organizationId, contactId);

  // REGLA 1: solo se reserva lo que se ofreció.
  if (input.requireOffer) {
    if (!input.conversationId) {
      throw new BookingError(
        "invalid",
        "Se necesita la conversación para validar la oferta"
      );
    }
    const offers = await getOffers(input.organizationId, input.conversationId);
    if (!findOffered(offers, input.startUtc)) {
      throw new BookingError(
        "slot_not_offered",
        "Ese horario no se ofreció en esta conversación",
        offers
      );
    }
  }

  // REGLA 3 (auditoría 2026-09-17): no crear en silencio una SEGUNDA cita
  // activa para un contacto que ya tiene una, o que tiene un cambio de
  // horario pendiente. `allowAdditional` es la única salida, y exige
  // constancia escrita (`notes`) — no basta con que el llamador lo pida sin
  // dejar dicho POR QUÉ, porque eso es indistinguible de inferirlo solo.
  if (input.allowAdditional) {
    if (!input.notes?.trim()) {
      throw new BookingError(
        "invalid",
        "Una cita adicional confirmada necesita decir, en notas, por qué es una reunión aparte"
      );
    }
  } else {
    const pendingChange = await getPendingRescheduleRequest(
      input.organizationId,
      contactId
    );
    if (pendingChange) {
      const originalLabel = pendingChange.originalBookingId
        ? await getBookingLabel(
            input.organizationId,
            pendingChange.originalBookingId,
            settings
          )
        : null;
      throw new BookingError(
        "reschedule_pending",
        "Hay un cambio de horario pendiente para este contacto",
        [],
        {
          bookingId: pendingChange.originalBookingId ?? "",
          label: originalLabel ?? "su cita activa",
        }
      );
    }
    const active = await findActiveBooking(input.organizationId, contactId, {
      now: input.now,
    });
    if (active) {
      throw new BookingError(
        "existing_booking",
        "El contacto ya tiene una cita activa",
        [],
        {
          bookingId: active.id,
          label: labelInTz(active.scheduledAt.toISOString(), settings.timezone),
        }
      );
    }
  }

  // REGLA 2 (primera mitad): el hueco debe seguir libre AHORA.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    now: input.now,
    settings,
  });
  if (!slot) {
    throw new BookingError(
      "slot_taken",
      "Ese horario ya no está disponible",
      await refreshOffer(input.organizationId, input.conversationId, {
        now: input.now,
      })
    );
  }

  const leadRows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);

  let booking: BookingRow;
  try {
    const inserted = await db
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "session",
        source: input.source === "ai" ? "ai" : "manual",
        contactId,
        conversationId: input.conversationId ?? null,
        leadId: leadRows[0]?.id ?? null,
        scheduledAt: new Date(slot.startUtc),
        durationMinutes: settings.slotMinutes,
        // Copia histórica: si el negocio cambia de conector, esta cita conserva
        // el que le tocó y sigue hablando con él al moverse o cancelarse.
        connector: settings.connector,
        isTest,
        additionalConfirmed: input.allowAdditional === true,
        notes: input.notes ?? null,
      })
      .returning();
    booking = inserted[0]!;
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    if (constraint === null) throw err;

    // REGLA 3 (segunda mitad): la carrera por CONTACTO. El pre-chequeo de
    // arriba deja una ventana entre leer y escribir; esto la cierra en la
    // base — dos `book_slot` casi simultáneos para el mismo contacto no
    // pueden colar los dos, sin importar que pidan instantes distintos (el
    // bug reportado: jueves 09:00 Y jueves 10:00 para el mismo prospecto).
    if (constraint === "booking_org_contact_single_active_uq") {
      const active = await findActiveBooking(input.organizationId, contactId, {
        now: input.now,
      });
      throw new BookingError(
        "existing_booking",
        "El contacto ya tiene una cita activa",
        [],
        active
          ? {
              bookingId: active.id,
              label: labelInTz(active.scheduledAt.toISOString(), settings.timezone),
            }
          : null
      );
    }

    // REGLA 2 (segunda mitad): la llave única del HUECO cierra la carrera
    // exacta. Dos confirmaciones simultáneas del mismo instante — la
    // perdedora sale por aquí, sin cita creada. Cualquier otro nombre de
    // restricción (o uno que el driver de pruebas no informe) cae aquí
    // también: `slot_taken` fue siempre el default de este choque.
    throw new BookingError(
      "slot_taken",
      "Ese horario acaba de ocuparse",
      await refreshOffer(input.organizationId, input.conversationId, {
        now: input.now,
      })
    );
  }

  // La oferta cumplió su propósito.
  if (input.conversationId) {
    await clearOffers(input.organizationId, input.conversationId).catch(
      (err) => {
        console.warn(`[agenda] no pude limpiar la oferta: ${err}`);
      }
    );
  }

  // Efectos secundarios: ninguno puede revertir la cita.
  const delivered = await deliverMeeting(booking, settings, contactName);
  await advanceLeadStage(
    input.organizationId,
    contactId,
    input.source === "ai" ? "bot" : "dueno"
  ).catch((err) => {
    console.warn(`[agenda] avance de etapa falló: ${err}`);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });

  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

export async function createBlock(input: {
  organizationId: string;
  startUtc: string;
  durationMinutes: number;
  notes?: string | null;
}): Promise<BookingRow> {
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const db = getDb();
  try {
    const inserted = await db
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "block",
        source: "manual",
        scheduledAt: new Date(input.startUtc),
        durationMinutes: input.durationMinutes,
        notes: input.notes ?? null,
      })
      .returning();
    const block = inserted[0]!;
    publish(input.organizationId, {
      type: "booking.updated",
      data: { bookingId: block.id },
    });
    return block;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
}

export async function rescheduleBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") {
    throw new BookingError("invalid", "La cita está cancelada");
  }

  const settings = await getSettings(input.organizationId);
  // excludeBookingId: la propia cita no debe bloquearse a sí misma.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    excludeBookingId: booking.id,
    now: input.now,
    settings,
  });
  if (!slot) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }

  let next: BookingRow;
  try {
    const updated = await db
      .update(schema.booking)
      .set({ scheduledAt: new Date(slot.startUtc), updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id))
      .returning();
    next = updated[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario acaba de ocuparse");
    }
    throw err;
  }

  // Mover la reunión en el proveedor conserva el enlace: es la MISMA reunión,
  // en otra hora. Un fallo aquí no deshace nada — el enlace anterior sigue
  // sirviendo en la práctica.
  await withConnector(next, settings, async (conn, externalRef) => {
    await conn.updateMeeting(externalRef, {
      startUtc: slot.startUtc,
      durationMinutes: next.durationMinutes,
      timezone: settings.timezone,
    });
  });

  // Auditoría 2026-09-17 — un reprogramar REAL es el único desenlace que
  // atiende de verdad un cambio pendiente: se resuelve aquí y en ningún otro
  // lugar (nunca por inferencia del modelo ni porque cambió el tema).
  if (next.contactId) {
    await resolvePendingRescheduleRequests(input.organizationId, next.contactId).catch(
      (err) => {
        console.warn(`[agenda] no pude resolver el cambio pendiente: ${err}`);
      }
    );
  }

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: next.id },
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

/**
 * Reprograma la PRÓXIMA cita activa de la conversación. Es el camino del
 * agente: mover una cita no debería obligar a pausar la IA y pasarle el
 * problema a un humano.
 */
export async function rescheduleForConversation(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const convRows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new BookingError("not_found", "Conversación no encontrada");

  // Mismas reglas que al crear: el instante nuevo tiene que haberse ofrecido.
  const offers = await getOffers(input.organizationId, input.conversationId);
  if (!findOffered(offers, input.startUtc)) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        input.organizationId,
        and(
          eq(schema.booking.contactId, conv.contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);

  const target = rows[0];
  if (!target) {
    throw new BookingError("not_found", "No hay una cita activa que mover");
  }

  const result = await rescheduleBooking({
    organizationId: input.organizationId,
    bookingId: target.id,
    startUtc: input.startUtc,
    now: input.now,
  });
  await clearOffers(input.organizationId, input.conversationId).catch(() => {});
  return result;
}

/** Idempotente: cancelar una cita ya cancelada no falla ni cambia nada. */
export async function cancelBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") return;

  await db
    .update(schema.booking)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(eq(schema.booking.id, booking.id));

  // Incidente 2026-09-19 — cancelar desde la pantalla de Citas dejaba VIVA la
  // solicitud de cambio de horario del contacto: `pending` para siempre. Y un
  // pendiente hace que `createSessionBooking` (arriba) lance
  // `reschedule_pending`, así que el agente ya no podía volver a agendarle
  // nada a ese prospecto — por una cita que ya no existe. Cancelar la cita SÍ
  // atiende el pedido de moverla: no queda nada que mover.
  //
  // Va DENTRO del camino que sí trabaja (después del early return de
  // idempotencia) a propósito: solo puede haber una solicitud pendiente por
  // contacto, así que cancelar dos veces una cita ya muerta podría resolver el
  // pedido de OTRA cita viva.
  if (booking.contactId) {
    await resolvePendingRescheduleRequests(
      input.organizationId,
      booking.contactId
    ).catch((err) => {
      console.warn(`[agenda] no pude resolver el cambio pendiente: ${err}`);
    });
  }

  const settings = await getSettings(input.organizationId);
  await withConnector(booking, settings, async (conn, externalRef) => {
    await conn.deleteMeeting(externalRef);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
}

export async function markBookingStatus(input: {
  organizationId: string;
  bookingId: string;
  status: "realizada" | "no_show";
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  try {
    await db
      .update(schema.booking)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id));
  } catch (err) {
    // Reactivar a `realizada` un instante que otra cita ya ocupa.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
}

/**
 * Reintenta la entrega de una cita que quedó sin enlace porque el proveedor
 * falló. Habla con el conector con el que NACIÓ la cita, no con el activo.
 *
 * Sin esto, un hipo del proveedor sería una pérdida silenciosa que nadie
 * repara — que es exactamente lo que pasa hoy en el fork.
 */
export async function retryMeetingLink(input: {
  organizationId: string;
  bookingId: string;
}): Promise<BookingResult> {
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (!booking.linkPending) {
    throw new BookingError("invalid", "Esta cita no tiene un enlace pendiente");
  }
  const settings = await getSettings(input.organizationId);
  const contactName = booking.contactId
    ? await getContactName(input.organizationId, booking.contactId)
    : "";
  const delivered = await deliverMeeting(booking, settings, contactName);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });
  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(delivered.scheduledAt.toISOString(), settings.timezone),
  };
}

/**
 * Crea la reunión en el proveedor y la guarda en la cita.
 *
 * SANDBOX: una cita del Laboratorio jamás llega a un conector. La aserción va
 * aquí, ANTES de resolver cuál es, para que valga igual para todos — hoy y
 * para el que agregue un fork mañana.
 */
async function deliverMeeting(
  booking: BookingRow,
  settings: CalendarSettings,
  contactName: string
): Promise<BookingRow> {
  if (booking.isTest) return booking;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;

  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );

    // Si la cita YA tiene reunión, esto es un reintento: se vuelve a leer, no
    // se crea otra. Sin esta rama, reintentar el enlace de un evento de Google
    // dejaría al dueño con dos citas en su calendario.
    // Mismo título que el .ics y los enlaces de Google/Outlook
    // (`bookingCopy`, `public-view.ts`): un prospecto que compara su
    // confirmación contra el evento real del dueño nunca ve dos nombres
    // distintos para la misma cita. El nombre del contacto va en la
    // descripción, no en el título — ahí sigue siendo útil para el dueño.
    const meeting =
      booking.externalRef && conn.refreshMeeting
        ? await conn.refreshMeeting(booking.externalRef)
        : await conn.createMeeting({
            topic: settings.appointmentTitle,
            startUtc: booking.scheduledAt.toISOString(),
            durationMinutes: booking.durationMinutes,
            timezone: settings.timezone,
            notes:
              [
                contactName ? `Cita de ${contactName}.` : null,
                booking.notes,
              ]
                .filter((v): v is string => Boolean(v))
                .join("\n\n") || undefined,
          });

    return await persistDelivery(booking.id, {
      externalRef: meeting.externalId ?? booking.externalRef,
      meetingLink: meeting.joinUrl,
      // Un conector que promete enlace por cita y no lo trajo todavía deja la
      // cita "sin enlace" — reintentable. `enlace-fijo` sin sala configurada,
      // en cambio, no tiene nada pendiente: simplemente no hay enlace.
      linkPending: CONNECTOR_META[connectorId].perBookingLink && !meeting.joinUrl,
    });
  } catch (err) {
    console.warn(
      `[agenda] el conector ${connectorId} no pudo entregar la reunión: ${err}`
    );
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
    // La cita ya existe y se queda: el enlace es lo único que falta. Se
    // conserva la referencia externa si ya la había, para que el reintento
    // sepa que no debe crear otra reunión.
    return await persistDelivery(booking.id, {
      externalRef: booking.externalRef,
      meetingLink: null,
      linkPending: true,
    });
  }
}

async function persistDelivery(
  bookingId: string,
  values: {
    externalRef: string | null;
    meetingLink: string | null;
    linkPending: boolean;
  }
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .update(schema.booking)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.booking.id, bookingId))
    .returning();
  return rows[0]!;
}

/**
 * Corre un efecto sobre el proveedor de una cita ya creada (mover, borrar).
 * Best-effort y con el mismo guardarraíl de sandbox. Sin `external_ref` no hay
 * nada que mover: el conector no generó reunión (p. ej. el enlace fijo).
 */
async function withConnector(
  booking: BookingRow,
  settings: CalendarSettings,
  run: (
    conn: Awaited<ReturnType<typeof bindConnector>>,
    externalRef: string
  ) => Promise<void>
): Promise<void> {
  if (booking.isTest || !booking.externalRef) return;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;
  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );
    await run(conn, booking.externalRef);
  } catch (err) {
    console.warn(`[agenda] efecto en ${connectorId} falló: ${err}`);
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
  }
}

/**
 * Alternativas frescas para re-ofrecer. Si hay conversación, quedan
 * REGISTRADAS como su nueva oferta: el cliente puede aceptar una de inmediato
 * y la validación seguirá siendo válida.
 */
async function refreshOffer(
  organizationId: string,
  conversationId: string | null | undefined,
  opts: { now?: Date }
): Promise<OfferedSlot[]> {
  let fresh: AvailableSlot[] = [];
  try {
    fresh = (await computeAvailability(organizationId, { now: opts.now })).slice(
      0,
      FRESH_ALTERNATIVES
    );
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  const offers: OfferedSlot[] = fresh.map((s) => ({
    startUtc: s.startUtc,
    label: s.label,
  }));
  if (conversationId && offers.length > 0) {
    await replaceOffers(organizationId, conversationId, offers).catch((err) => {
      console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
    });
  }
  return offers;
}

async function getOwnBooking(
  organizationId: string,
  bookingId: string
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BookingError("not_found", "Cita no encontrada");
  return rows[0];
}

async function getContactName(
  organizationId: string,
  contactId: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

/**
 * El lead avanza a la siguiente etapa abierta al agendar — solo hacia adelante,
 * nunca retrocede.
 *
 * Pasa por `moveLeadToStage`, la única puerta que puede escribir `stage_id`:
 * mover el lead y registrar el movimiento en la bitácora son la misma
 * operación. Escribir el UPDATE aquí no truena, solo hace que las gráficas
 * mientan meses después — y hay un test de vigilancia que lo impide.
 */
async function advanceLeadStage(
  organizationId: string,
  contactId: string,
  source: "bot" | "dueno"
): Promise<void> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id, stageId: schema.lead.stageId })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const lead = leads[0];
  if (!lead) return;

  const stages = await db
    .select({
      id: schema.pipelineStage.id,
      position: schema.pipelineStage.position,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const currentIdx = stages.findIndex((s) => s.id === lead.stageId);
  if (currentIdx < 0) return;
  const nextOpen = stages.find((s, i) => i > currentIdx && s.kind === "open");
  if (!nextOpen) return; // ya está en la última etapa abierta (o en un ancla)

  await moveLeadToStage({
    organizationId,
    leadId: lead.id,
    toStageId: nextOpen.id,
    source,
    extra: { lastActivityAt: new Date() },
  });
}

/** Citas que ocupan agenda de verdad. */
export const ACTIVE_STATUSES = ["agendada", "realizada"] as const;

/**
 * El predicado ÚNICO de "cita que ocupa agenda de verdad", para que el
 * blindaje de escritura y la lectura de contexto no puedan desfasarse el día
 * que alguien toque `ACTIVE_STATUSES`.
 */
function activeBookingWhere(
  organizationId: string,
  contactId: string,
  opts: { isTest: boolean; now?: Date }
) {
  return scoped(
    schema.booking.organizationId,
    organizationId,
    and(
      eq(schema.booking.contactId, contactId),
      eq(schema.booking.kind, "session"),
      eq(schema.booking.isTest, opts.isTest),
      inArray(schema.booking.status, [...ACTIVE_STATUSES]),
      gte(schema.booking.scheduledAt, opts.now ?? new Date())
    )
  );
}

/**
 * La cita activa (futura, `session`, no de prueba) de un contacto, si tiene
 * una. Lo usa el blindaje de `createSessionBooking` — y quien conduzca la
 * conversación, para nombrarla en vez de responder en genérico.
 *
 * `is_test = false` NO se parametriza a propósito: esta función es el blindaje
 * que se apoya en el índice único `booking_org_contact_single_active_uq`, y
 * ese índice parcial solo cubre las citas reales. Un `isTest` opcional aquí
 * invitaría a llamarla con `true` creyendo que garantiza algo que la base no
 * garantiza. Para MIRAR el sandbox está `listActiveBookings`.
 */
export async function findActiveBooking(
  organizationId: string,
  contactId: string,
  opts: { now?: Date } = {}
): Promise<BookingRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(activeBookingWhere(organizationId, contactId, { isTest: false, now: opts.now }))
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Incidente 2026-09-19 — lector de CONTEXTO: las citas vigentes de un contacto
 * para contarle al agente el estado real. Es hermano de `findActiveBooking`,
 * no un sustituto: aquél blinda una escritura, éste solo informa, y por eso
 * puede mirar el sandbox del Laboratorio (`isTest`) y devolver más de una
 * (un contacto con `additional_confirmed` legítimamente tiene dos, y nombrar
 * solo la más próxima sería contarle media verdad al modelo).
 */
export async function listActiveBookings(
  organizationId: string,
  contactId: string,
  opts: { isTest: boolean; now?: Date; limit?: number }
): Promise<BookingRow[]> {
  const db = getDb();
  return await db
    .select()
    .from(schema.booking)
    .where(activeBookingWhere(organizationId, contactId, opts))
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(opts.limit ?? 3);
}

async function getBookingLabel(
  organizationId: string,
  bookingId: string,
  settings: CalendarSettings
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ scheduledAt: schema.booking.scheduledAt })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return labelInTz(row.scheduledAt.toISOString(), settings.timezone);
}

/** 23505 = unique_violation de Postgres. */
function isUniqueViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err) !== null;
}

/**
 * Nombre del índice/restricción único que chocó, o null si el error no es
 * eso. Distinguir POR CUÁL índice importa desde la auditoría 2026-09-17: el
 * mismo 23505 puede venir del choque de HUECO (`booking_org_active_slot_uq`,
 * ya existía) o del choque de CONTACTO (`booking_org_contact_single_active_uq`,
 * nuevo) — cada uno se traduce a un `BookingErrorCode` distinto.
 */
function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const direct = err as { code?: unknown; constraint?: unknown };
  if (direct.code === "23505") return readConstraint(direct);
  // Drizzle envuelve el error del driver: el código real viaja en `cause`.
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  ) {
    return readConstraint(cause as { constraint?: unknown });
  }
  return null;
}

function readConstraint(obj: { constraint?: unknown }): string | null {
  return typeof obj.constraint === "string" ? obj.constraint : "unknown";
}
