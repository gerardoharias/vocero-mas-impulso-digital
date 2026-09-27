import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  parseClarifyContext,
  serializeClarifyContext,
  EMPTY_CLARIFY_STATE,
  type AgendaClarifyState,
} from "@/server/agenda/agenda-clarify-context";

/**
 * 026 — Persistencia de la memoria de aclaración de disponibilidad
 * (`conversation.agenda_clarify_*`, migración 0024). Mismo patrón que
 * `src/server/ai/failure-state.ts` (023): vive en columnas de `conversation`,
 * no en memoria ni en el texto de los mensajes — sobrevive a reinicios y lo
 * comparten varias instancias.
 *
 * Toda lectura/escritura va acotada por `id` + `organizationId` (multi-tenancy,
 * Principio III). La escritura es una única sentencia UPDATE guardada con el
 * contador que se leyó (concurrencia optimista): dos turnos a la vez sobre la
 * MISMA conversación no se pisan de forma silenciosa — el que pierde la
 * carrera simplemente no aplica su escritura (bajísimo riesgo: sólo cambia
 * qué variante de texto se usa la próxima vez, nunca afirma disponibilidad).
 */

type ConvRow = {
  agendaClarifyCount: number;
  agendaClarifyKind: string | null;
  agendaClarifyContext: string | null;
};

type ConvRef = { id: string; organizationId: string };

/** Lee el estado desde la fila YA cargada de `conversation` (sin otra consulta). */
export function loadAgendaClarifyState(conv: ConvRow): AgendaClarifyState {
  return {
    count: conv.agendaClarifyCount,
    kind: (conv.agendaClarifyKind as AgendaClarifyState["kind"]) ?? null,
    context: parseClarifyContext(conv.agendaClarifyContext),
  };
}

/**
 * Escribe el nuevo estado (turno que NO resolvió, o que escaló). Guardada con
 * el contador leído al inicio del turno: si alguien más ya lo cambió, esta
 * escritura no aplica (no hay nada crítico que proteger salvo la redacción).
 */
export async function writeAgendaClarifyState(
  conv: ConvRef,
  expectedPrevCount: number,
  next: AgendaClarifyState
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.conversation)
    .set({
      agendaClarifyCount: next.count,
      agendaClarifyKind: next.kind,
      agendaClarifyContext: serializeClarifyContext(next.context),
    })
    .where(
      and(
        eq(schema.conversation.id, conv.id),
        eq(schema.conversation.organizationId, conv.organizationId),
        eq(schema.conversation.agendaClarifyCount, expectedPrevCount)
      )
    );
}

/**
 * Un turno que SÍ resolvió (o se creó una cita, o cambió de tema de forma
 * inequívoca): limpia el contador (regla 11 a/b/c). El handoff (d/e) se
 * limpia aparte, dentro de `applyHandoff` — cualquier motivo, no sólo
 * `agenda_ambigua`.
 */
export async function resetAgendaClarifyState(conv: ConvRef): Promise<void> {
  const db = getDb();
  await db
    .update(schema.conversation)
    .set({ agendaClarifyCount: 0, agendaClarifyKind: null, agendaClarifyContext: null })
    .where(
      and(eq(schema.conversation.id, conv.id), eq(schema.conversation.organizationId, conv.organizationId))
    );
}

export { EMPTY_CLARIFY_STATE };
