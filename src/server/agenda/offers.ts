import { dayIsoInTz, dayLabelInTz } from "@/lib/time/slots";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Memoria de lo ofrecido a una conversación (requisito INNEGOCIABLE).
 *
 * Sin fila aquí no hay reserva: es lo que impide que un modelo alucine un
 * horario que nunca se le ofreció al cliente. La oferta se reemplaza completa
 * en cada ronda (la vigente es siempre la última) y se limpia al reservar.
 */

export type OfferedSlot = {
  startUtc: string;
  label: string;
  /**
   * 024 — aparece en el TEXTO del mensaje (el catálogo registrado es más ancho
   * que el menú). Sólo estos se revalidan antes de reenviar. Por omisión, sí.
   */
  shown?: boolean;
};

/**
 * 024 — Los horarios que un mensaje muestra nacen `pending` (no seleccionables:
 * el prospecto aún no los ha visto) y ligados a ese mensaje. Se insertan dentro
 * de la MISMA transacción que el mensaje (`server/outbox`), así que nunca hay
 * horarios "ofrecidos" sin el mensaje que los ofrece, ni al revés.
 */
export type OfferTx = Pick<ReturnType<typeof getDb>, "insert">;
type UpdateTx = Pick<ReturnType<typeof getDb>, "update">;

/**
 * 024 — Estado de la RONDA en el mensaje que la mostró (`message.offer_state`).
 * Es lo que permite saber, MESES después, si un mensaje fallido sigue siendo la
 * oferta vigente o ya fue sustituido/reservado (las filas de `offered_slot` se
 * borran al reemplazar; el mensaje conserva el veredicto).
 */
async function markRounds(
  tx: UpdateTx,
  where: {
    organizationId: string;
    conversationId: string;
    from: ("pending" | "active")[];
    to: "superseded" | "consumed";
    exceptMessageId?: string;
  }
): Promise<void> {
  await tx
    .update(schema.message)
    .set({ offerState: where.to })
    .where(
      scoped(
        schema.message.organizationId,
        where.organizationId,
        and(
          eq(schema.message.conversationId, where.conversationId),
          inArray(schema.message.offerState, where.from),
          where.exceptMessageId
            ? ne(schema.message.id, where.exceptMessageId)
            : undefined
        )
      )
    );
}

export async function insertPendingOffers(
  tx: OfferTx,
  input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    slots: OfferedSlot[];
  }
): Promise<void> {
  if (input.slots.length === 0) return;
  await tx.insert(schema.offeredSlot).values(
    input.slots.map((s) => ({
      id: newId("offeredSlot"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      state: "pending" as const,
      startUtc: new Date(s.startUtc),
      label: s.label,
      shown: s.shown ?? true,
    }))
  );
}

/**
 * 024 — Meta aceptó el mensaje que muestra estos horarios: pasan a `active`
 * (seleccionables) y reemplazan cualquier otra ronda de la conversación. Es
 * idempotente: sin filas `pending` de ese mensaje no hace nada.
 */
export async function activateOffers(messageId: string): Promise<number> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({
        organizationId: schema.offeredSlot.organizationId,
        conversationId: schema.offeredSlot.conversationId,
      })
      .from(schema.offeredSlot)
      .where(
        and(
          eq(schema.offeredSlot.messageId, messageId),
          eq(schema.offeredSlot.state, "pending")
        )
      )
      .limit(1);
    const head = pending[0];
    if (!head) return 0;

    // Cualquier otra ronda de la conversación queda sustituida (y su mensaje lo sabe).
    await markRounds(tx, {
      organizationId: head.organizationId,
      conversationId: head.conversationId,
      from: ["pending", "active"],
      to: "superseded",
      exceptMessageId: messageId,
    });
    await tx
      .update(schema.message)
      .set({ offerState: "active" })
      .where(eq(schema.message.id, messageId));
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          head.organizationId,
          and(
            eq(schema.offeredSlot.conversationId, head.conversationId),
            or(
              isNull(schema.offeredSlot.messageId),
              ne(schema.offeredSlot.messageId, messageId)
            )
          )
        )
      );
    const activated = await tx
      .update(schema.offeredSlot)
      .set({ state: "active" })
      .where(eq(schema.offeredSlot.messageId, messageId))
      .returning({ id: schema.offeredSlot.id });
    return activated.length;
  });
}

/** Reemplaza TODA la oferta de la conversación, en una transacción. */
export async function replaceOffers(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[]
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Una ronda nueva sin mensaje propio (API del cerebro externo, re-oferta)
    // deja obsoleta cualquier oferta anterior que un mensaje fallido conserve.
    await markRounds(tx, {
      organizationId,
      conversationId,
      from: ["pending", "active"],
      to: "superseded",
    });
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          organizationId,
          eq(schema.offeredSlot.conversationId, conversationId)
        )
      );
    if (slots.length === 0) return;
    await tx.insert(schema.offeredSlot).values(
      slots.map((s) => ({
        id: newId("offeredSlot"),
        organizationId,
        conversationId,
        startUtc: new Date(s.startUtc),
        label: s.label,
      }))
    );
  });
}

export async function getOffers(
  organizationId: string,
  conversationId: string
): Promise<OfferedSlot[]> {
  const db = getDb();
  const rows = await db
    .select({
      startUtc: schema.offeredSlot.startUtc,
      label: schema.offeredSlot.label,
    })
    .from(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        and(
          eq(schema.offeredSlot.conversationId, conversationId),
          // 024: lo que el prospecto aún no ha visto (mensaje sin aceptar) no
          // se puede reservar ni se le da al modelo como "ya ofrecido".
          eq(schema.offeredSlot.state, "active")
        )
      )
    )
    .orderBy(asc(schema.offeredSlot.startUtc));

  return rows.map((r) => ({
    startUtc: r.startUtc.toISOString(),
    label: r.label,
  }));
}

export async function clearOffers(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // El prospecto reservó: ninguna oferta previa se puede reenviar.
    await markRounds(tx, {
      organizationId,
      conversationId,
      from: ["pending", "active"],
      to: "consumed",
    });
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          organizationId,
          eq(schema.offeredSlot.conversationId, conversationId)
        )
      );
  });
}

/**
 * ¿El instante pedido está entre los ofrecidos? Comparación por **epoch
 * exacto**: nada de tolerancias ni de comparar texto. Un ISO con otro offset
 * pero el mismo instante SÍ vale; un minuto de diferencia NO.
 *
 * La tolerancia sería la puerta por donde entra la alucinación: un modelo
 * inventa "el martes a las 10" con facilidad, y comparar exacto convierte eso
 * en un rechazo con la lista de lo que sí se ofreció.
 */
export function findOffered(
  offers: OfferedSlot[],
  whenISO: string
): OfferedSlot | null {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;
  return offers.find((o) => Date.parse(o.startUtc) === target) ?? null;
}

/** Igualdad de instante, expuesta para tests. */
export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}

/**
 * Los días distintos que cubre la oferta vigente, con su ISO y su etiqueta.
 *
 * Es el índice que le permite al modelo PEDIR otro día (`offer_slots.day`)
 * copiando un valor en vez de calcular una fecha — el mismo motivo por el que
 * existe el mapa `label → startUtc` para reservar. Incidente 2026-09-20.
 */
export function offerDays(
  offers: { startUtc: string; label: string }[],
  timezone: string,
  now: Date
): { day: string; label: string }[] {
  const vistos = new Map<string, string>();
  for (const o of offers) {
    const day = dayIsoInTz(new Date(o.startUtc), timezone);
    if (!vistos.has(day)) vistos.set(day, dayLabelInTz(o.startUtc, timezone, now));
  }
  return [...vistos.entries()].map(([day, label]) => ({ day, label }));
}
