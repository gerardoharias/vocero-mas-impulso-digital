import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Estado técnico de los fallos de IA por CONVERSACIÓN (spec 023 §3.6).
 *
 * Vive en columnas de `conversation` (migración 0022), no en memoria ni en el
 * texto de los mensajes:
 * - sobrevive a reinicios y despliegues;
 * - lo comparten varias instancias: el incremento es UNA sentencia SQL atómica
 *   (`count + 1` calculado por la base), nunca leer-y-escribir;
 * - es independiente de lo que el cliente ve (`AI_FALLBACK_MESSAGE` puede
 *   cambiar, un operador puede escribir lo mismo: no afecta).
 *
 * Alcance elegido — conversación — porque lo que se decide con él es "¿este
 * cliente ya recibió una degradación y volvió a fallar?": una decisión sobre
 * SU hilo. Lo global (modelo/organización) lo cubre el circuito de protección.
 */

/** Fallos de formato consecutivos en una conversación a partir de los cuales ya no es "aislado". */
export const CONSECUTIVE_FORMAT_FAILURES_LIMIT = 2;

/**
 * Un fallo más viejo que esto ya no cuenta como "el turno anterior": el
 * contador reinicia en 1. Acota el caso de un fallo suelto de hace días.
 */
export const FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;

type ConvRef = { id: string; organizationId: string };

/**
 * Registra un fallo de formato y devuelve cuántos van consecutivos (≥ 1).
 * Atómico: dos turnos concurrentes (misma o distinta instancia) obtienen
 * conteos distintos y consecutivos, jamás el mismo.
 */
export async function recordFormatFailure(
  conv: ConvRef,
  code: string,
  now: Date = new Date()
): Promise<number> {
  const db = getDb();
  // ISO + cast: un `Date` dentro de un sql`` crudo NO pasa por el mapeo de
  // columnas de drizzle y postgres-js lo rechaza (lo destapó verify-ai-fail-state.ts).
  const cutoff = new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString();
  const rows = await db
    .update(schema.conversation)
    .set({
      aiFailCount: sql`CASE WHEN ${schema.conversation.aiFailAt} IS NOT NULL AND ${schema.conversation.aiFailAt} > ${cutoff}::timestamp THEN ${schema.conversation.aiFailCount} + 1 ELSE 1 END`,
      aiFailKind: code,
      aiFailAt: now,
    })
    .where(
      and(
        eq(schema.conversation.id, conv.id),
        eq(schema.conversation.organizationId, conv.organizationId)
      )
    )
    .returning({ count: schema.conversation.aiFailCount });
  return rows[0]?.count ?? 1;
}

/** Un turno exitoso (o reactivar la IA) reinicia el contador. */
export async function resetFailureState(conv: ConvRef): Promise<void> {
  const db = getDb();
  await db
    .update(schema.conversation)
    .set({ aiFailCount: 0, aiFailKind: null, aiFailAt: null })
    .where(
      and(
        eq(schema.conversation.id, conv.id),
        eq(schema.conversation.organizationId, conv.organizationId)
      )
    );
}

export const CIRCUIT_NOTICE_KIND = "circuit_open";

/**
 * Marca que a esta conversación ya se le avisó durante un circuito abierto
 * (para no repetir el aviso en cada mensaje). NO toca el contador: un aviso
 * de circuito no es un fallo de formato de la conversación.
 */
export async function markCircuitNotice(
  conv: ConvRef,
  now: Date = new Date()
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.conversation)
    .set({ aiFailKind: CIRCUIT_NOTICE_KIND, aiFailAt: now })
    .where(
      and(
        eq(schema.conversation.id, conv.id),
        eq(schema.conversation.organizationId, conv.organizationId)
      )
    );
}

/** ¿Esta conversación ya recibió el aviso del circuito hace menos de `withinMs`? */
export function circuitNoticeRecent(
  conv: { aiFailKind?: string | null; aiFailAt?: Date | null },
  withinMs: number,
  now: number = Date.now()
): boolean {
  return (
    conv.aiFailKind === CIRCUIT_NOTICE_KIND &&
    conv.aiFailAt instanceof Date &&
    now - conv.aiFailAt.getTime() < withinMs
  );
}
