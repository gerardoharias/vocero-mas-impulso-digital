import { and, eq, gt, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { overlaps } from "@/lib/time/slots";
import { getSettings } from "@/server/agenda/settings";

/**
 * 024 — ¿Sigue siendo vigente la ronda de horarios que un mensaje muestra?
 *
 * Sólo lee la base (mensajes, `offered_slot`, citas): NO ejecuta el motor de
 * disponibilidad, `offer_slots` ni el modelo, así que puede correr antes de un
 * reintento automático sin romper la garantía G4.
 *
 * SEMÁNTICA DE `pending` (spec 024 §5.6): un horario `pending` NO reserva
 * disponibilidad. Es una opción que el prospecto todavía no ha visto. Mientras el
 * mensaje espera su reintento, otro prospecto puede reservar ese hueco (gana el
 * primero: el índice único de `booking` lo decide). Por eso, ANTES de enviar
 * —automática o manualmente— se revalida lo que el texto enseña, y si el sistema
 * ya sabe que algo dejó de estar libre, el mensaje NO sale. No hay reservas
 * fantasma ni bloqueos indefinidos: una fila `pending` nunca bloquea a nadie.
 */

export type StaleReason =
  /** Una ronda posterior, una reserva o una revalidación la volvieron obsoleta. */
  | "superseded"
  /** Existe otro mensaje de horarios más reciente en la conversación. */
  | "later_round"
  /** Sus horarios ya no existen (se reemplazaron). */
  | "no_offers"
  /** Algún horario mostrado ya pasó (o cae dentro del aviso mínimo). */
  | "expired"
  /** Algún horario mostrado lo ocupa una cita o un bloqueo. */
  | "occupied"
  /** (Sólo reenvío manual) el motor de disponibilidad ya no lo ofrece. */
  | "unavailable";

export type OfferCheck =
  /** El mensaje no es una oferta de horarios: nada que validar. */
  | { applies: false }
  | { applies: true; ok: true; shownStarts: string[]; organizationId: string }
  | { applies: true; ok: false; reason: StaleReason };

export const STALE_COPY: Record<StaleReason, string> = {
  superseded: "ya fue sustituida, reservada o cancelada",
  later_round: "hay una ronda de horarios más reciente",
  no_offers: "sus horarios ya no existen",
  expired: "algún horario ya venció",
  occupied: "algún horario ya está ocupado",
  unavailable: "algún horario ya no está disponible",
};

/** Mensaje al operador: por qué se bloquea y qué hacer. */
export function staleMessage(reason: StaleReason): string {
  return (
    `Esta oferta de horarios ya no es vigente (${STALE_COPY[reason]}). ` +
    "No se reenvía para no ofrecer horarios que pueden no estar libres: " +
    "genera una nueva ronda con la disponibilidad actualizada."
  );
}

export async function checkOfferFreshness(
  messageId: string,
  opts: { now?: Date } = {}
): Promise<OfferCheck> {
  const db = getDb();
  const now = opts.now ?? new Date();

  const rows = await db
    .select({
      id: schema.message.id,
      organizationId: schema.message.organizationId,
      conversationId: schema.message.conversationId,
      createdAt: schema.message.createdAt,
      offerState: schema.message.offerState,
    })
    .from(schema.message)
    .where(eq(schema.message.id, messageId))
    .limit(1);
  const m = rows[0];
  if (!m || m.offerState === null) return { applies: false };

  const stale = (reason: StaleReason): OfferCheck => ({
    applies: true,
    ok: false,
    reason,
  });

  if (m.offerState === "superseded" || m.offerState === "consumed") {
    return stale("superseded");
  }

  // ¿Hay una ronda posterior? Cualquier otro mensaje de horarios más nuevo
  // (aunque también haya fallado) basta: conservador.
  const later = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        m.organizationId,
        and(
          eq(schema.message.conversationId, m.conversationId),
          ne(schema.message.id, m.id),
          isNotNull(schema.message.offerState),
          gt(schema.message.createdAt, m.createdAt)
        )
      )
    )
    .limit(1);
  if (later.length > 0) return stale("later_round");

  const shown = await db
    .select({ startUtc: schema.offeredSlot.startUtc })
    .from(schema.offeredSlot)
    .where(
      and(
        eq(schema.offeredSlot.messageId, m.id),
        eq(schema.offeredSlot.shown, true)
      )
    );
  if (shown.length === 0) return stale("no_offers");

  const settings = await getSettings(m.organizationId);
  const minStart = now.getTime() + settings.minNoticeHours * 3_600_000;
  if (shown.some((r) => r.startUtc.getTime() < minStart)) return stale("expired");

  // ¿Alguna cita o bloqueo activo ocupa un horario mostrado? (Mismo criterio
  // que el motor: canceladas y no-show liberan; el sandbox no consume.)
  const first = Math.min(...shown.map((r) => r.startUtc.getTime()));
  const last = Math.max(...shown.map((r) => r.startUtc.getTime()));
  const DAY = 24 * 3_600_000;
  const busy = await db
    .select({
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        m.organizationId,
        and(
          inArray(schema.booking.status, ["agendada", "realizada"]),
          eq(schema.booking.isTest, false),
          // Ventana de un día alrededor de lo mostrado: una cita más lejana no
          // puede solaparse con un horario de `slotMinutes` (máx. 240).
          gt(schema.booking.scheduledAt, new Date(first - DAY)),
          lt(schema.booking.scheduledAt, new Date(last + DAY))
        )
      )
    );
  const slotMs = settings.slotMinutes * 60_000;
  for (const r of shown) {
    const sStart = r.startUtc.toISOString();
    const sEnd = new Date(r.startUtc.getTime() + slotMs).toISOString();
    for (const b of busy) {
      const bStart = b.scheduledAt.toISOString();
      const bEnd = new Date(b.scheduledAt.getTime() + b.durationMinutes * 60_000).toISOString();
      if (overlaps(sStart, sEnd, bStart, bEnd)) return stale("occupied");
    }
  }

  return {
    applies: true,
    ok: true,
    shownStarts: shown.map((r) => r.startUtc.toISOString()),
    organizationId: m.organizationId,
  };
}

/**
 * Marca la ronda de un mensaje como obsoleta (`superseded`): ya no se puede
 * reenviar ni manual ni automáticamente. No toca `offered_slot` ni otras rondas.
 */
export async function markOfferStale(messageId: string): Promise<void> {
  await getDb()
    .update(schema.message)
    .set({ offerState: "superseded" })
    .where(
      and(
        eq(schema.message.id, messageId),
        inArray(schema.message.offerState, ["pending", "active"])
      )
    );
}
