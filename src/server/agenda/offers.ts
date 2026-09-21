import { dayIsoInTz, dayLabelInTz } from "@/lib/time/slots";
import { asc, eq } from "drizzle-orm";
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

export type OfferedSlot = { startUtc: string; label: string };

/** Reemplaza TODA la oferta de la conversación, en una transacción. */
export async function replaceOffers(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[]
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
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
        eq(schema.offeredSlot.conversationId, conversationId)
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
  await db
    .delete(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    );
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
