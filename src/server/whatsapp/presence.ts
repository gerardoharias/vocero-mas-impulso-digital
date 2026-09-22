import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { graphRequest } from "@/lib/meta/client";
import { supportsTyping } from "@/server/channels/capabilities";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";

/**
 * Presencia hacia el contacto: marcar leído + "escribiendo…".
 *
 * Una sola llamada a Cloud API hace las dos cosas. Vive aquí y no dentro de un
 * route handler porque tiene DOS llamadores con necesidades distintas:
 * `/api/bot/typing` (el cerebro externo, que ramifica sobre el motivo para su
 * JSON) y el agente in-process, que solo necesita "hazlo y no me estorbes".
 *
 * Hasta el 2026-09-21 solo existía la ruta HTTP, así que el agente in-process
 * no podía señalar nada: el prospecto veía ~6 s de debounce más toda la
 * latencia del modelo en silencio absoluto, y luego el mensaje de golpe.
 *
 * NUNCA lanza. Eso es lo que permite que el mismo valor sirva a los dos: el
 * pipeline hace `await` sin ramificar, porque todos los caminos ya terminaron
 * en "no se hizo, y está bien".
 */

export type PresenceSkipReason =
  | "sandbox"
  | "channel_unsupported"
  | "ai_paused"
  | "no_inbound"
  | "no_connection"
  | "meta_error";

export type PresenceResult =
  | { ok: true }
  | { ok: false; reason: PresenceSkipReason };

/**
 * El indicador de Meta expira solo a los ~25 s. Por debajo de eso, volver a
 * encenderlo es una llamada tirada.
 */
export const TYPING_TTL_MS = 20_000;

/**
 * Cuándo se mandó la última señal de cada conversación.
 *
 * En memoria y colgado de `globalThis`, igual que el `coalesceMap` del
 * pipeline y por la misma razón: una instancia = un proceso, y Next recarga
 * módulos en desarrollo. Un reinicio entre la ingesta y el turno solo cuesta
 * una llamada redundante, que es la degradación correcta.
 */
const globalForPresence = globalThis as unknown as {
  __typingSentAt?: Map<string, number>;
};

function sentAt(): Map<string, number> {
  if (!globalForPresence.__typingSentAt) {
    globalForPresence.__typingSentAt = new Map();
  }
  return globalForPresence.__typingSentAt;
}

/** Solo para los tests: el estado vive en globalThis y sobrevive entre casos. */
export function __resetPresenceState(): void {
  globalForPresence.__typingSentAt = new Map();
}

type ConversationRow = typeof schema.conversation.$inferSelect;

/**
 * Marca leído el último entrante y enciende "escribiendo…".
 *
 * @param conversation Fila YA cargada y scopeada por el llamador. Se recibe la
 *   fila y no un id porque los tres llamadores ya la tienen en memoria: pedir
 *   un id obligaría a una query redundante en cada uno.
 * @param waMessageId El wamid, si el llamador ya lo conoce (la ingesta lo
 *   acaba de persistir). Sin él se busca el último entrante.
 * @param minIntervalMs No hacer nada si ya se señaló hace menos de esto.
 */
export async function markReadAndTyping(input: {
  conversation: ConversationRow;
  waMessageId?: string | null;
  minIntervalMs?: number;
}): Promise<PresenceResult> {
  const { conversation: conv } = input;

  // Guardrail constitucional del Laboratorio, ANTES de leer credenciales:
  // descifrar un secreto ya es demasiado para una conversación de prueba.
  //
  // A diferencia de `sendText`, que LANZA `sandbox_violation`, aquí se
  // devuelve el motivo: la superficie del bot ya responde así y el turno del
  // agente no debe reventar por una señal accesoria. La protección real no es
  // el throw — es que `graphRequest` no se llama, y eso lo fija un test.
  if (conv.isTest) return { ok: false, reason: "sandbox" };

  if (!supportsTyping(conv.channel)) {
    return { ok: false, reason: "channel_unsupported" };
  }

  // Handoff o IA en pausa: atiende un humano. "Escribiendo…" aquí sería
  // mentirle al cliente.
  if (!conv.aiEnabled || conv.handoffAt) {
    return { ok: false, reason: "ai_paused" };
  }

  const minInterval = input.minIntervalMs ?? 0;
  if (minInterval > 0) {
    const last = sentAt().get(conv.id);
    if (last !== undefined && Date.now() - last < minInterval) {
      return { ok: true };
    }
  }

  const wamid = input.waMessageId ?? (await lastInboundWamid(conv));
  if (!wamid) return { ok: false, reason: "no_inbound" };

  const creds = await getCredentialsByOrg(conv.organizationId);
  if (!creds) return { ok: false, reason: "no_connection" };

  try {
    await graphRequest(`${creds.phoneNumberId}/messages`, {
      method: "POST",
      token: creds.token,
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
        typing_indicator: { type: "text" },
      },
    });
  } catch {
    // Best-effort por contrato: nunca se reintenta. Una señal perdida es
    // invisible; un turno caído por ella, no.
    return { ok: false, reason: "meta_error" };
  }

  remember(conv.id);
  return { ok: true };
}

function remember(conversationId: string): void {
  const map = sentAt();
  map.set(conversationId, Date.now());
  // Poda perezosa: el estado es de este módulo, no del pipeline.
  if (map.size > 500) {
    const corte = Date.now() - 2 * TYPING_TTL_MS;
    for (const [id, t] of map) if (t < corte) map.delete(id);
  }
}

async function lastInboundWamid(conv: ConversationRow): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ waMessageId: schema.message.waMessageId })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, conv.organizationId),
        eq(schema.message.conversationId, conv.id),
        eq(schema.message.direction, "in"),
        isNotNull(schema.message.waMessageId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  return rows[0]?.waMessageId ?? null;
}
