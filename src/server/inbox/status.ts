import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { publish } from "@/server/events/bus";
import type { WebhookStatus } from "@/server/inbox/webhook";
import { applyAsyncFailure } from "@/server/outbox";

/** Orden monotónico de estados: nunca degradar (un delivered tardío no pisa read). */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

/**
 * Estados que un acuse de Meta puede tocar: sólo mensajes que Meta ya aceptó
 * (hay `wamid`). `queued`/`sending`/`retrying`/`delivery_unknown` no tienen
 * `wamid` que un acuse pueda nombrar.
 */

export function isUpgrade(current: string, next: string): boolean {
  if (next === "failed") return current !== "failed";
  const c = STATUS_RANK[current];
  const n = STATUS_RANK[next];
  if (c === undefined || n === undefined) return false;
  return n > c;
}

export async function applyStatusUpdate(
  organizationId: string,
  status: WebhookStatus
): Promise<void> {
  const next = status.status;
  if (!(next in STATUS_RANK) && next !== "failed") return; // estado desconocido
  // Los estados propios del outbox no viajan en los acuses de Meta.

  const db = getDb();
  const rows = await db
    .select({
      id: schema.message.id,
      organizationId: schema.message.organizationId,
      conversationId: schema.message.conversationId,
      status: schema.message.status,
      deliveryAttempts: schema.message.deliveryAttempts,
      traceId: schema.message.traceId,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.waMessageId, status.id)
      )
    )
    .limit(1);
  const msg = rows[0];
  if (!msg) return;
  if (!isUpgrade(msg.status, next)) return;

  const failure = status.errors?.[0];

  if (next === "failed") {
    // 024: el mismo mensaje, la política por CÓDIGO. Un fallo reintentable
    // vuelve a `retrying` (misma burbuja); el resto queda `failed`.
    const applied = await applyAsyncFailure({
      message: msg,
      code: failure?.code ?? null,
      detail: failure?.message ?? failure?.title,
    });
    publish(organizationId, {
      type: "message.status",
      data: {
        conversationId: msg.conversationId,
        messageId: msg.id,
        status: applied.status,
        // Sin esto el operador ve el triángulo de fallo pero nunca el motivo.
        error: applied.error,
      },
    });
    return;
  }

  const error = null;

  await db
    .update(schema.message)
    .set({ status: next as MessageStatus, error })
    .where(eq(schema.message.id, msg.id));

  publish(organizationId, {
    type: "message.status",
    data: {
      conversationId: msg.conversationId,
      messageId: msg.id,
      status: next,
      // Sin esto el operador ve el triángulo de fallo pero nunca el motivo.
      error,
    },
  });
}
