import { and, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { isPendingReply } from "@/server/inbox/pending";
import type { ConversationDto } from "@/lib/types";

/**
 * Auditoría 2026-09-17 — visibilidad de la Bandeja, en un solo lugar para no
 * repetir el criterio entre `listConversations` y quien lo pruebe. Por
 * defecto excluye:
 *  - datos de prueba/sistema (Fase 4, `contact.sample_type`);
 *  - contactos ARCHIVADOS (`contact.archived_at`): archivar es "hoy no lo
 *    trabajo", no "bórralo", así que por default no compite con la bandeja
 *    activa. `includeArchived` es el mismo patrón que "Ver archivados" en
 *    Contactos: agrega los archivados a la lista, nunca oculta los activos.
 * Un mensaje entrante nuevo desarchiva el contacto (ver
 * `ingestInboundMessage`), así que jamás se pierde en silencio.
 */
export function conversationVisibilityWhere(
  organizationId: string,
  opts: { since?: Date; includeArchived?: boolean } = {}
): SQL {
  return scoped(
    schema.conversation.organizationId,
    organizationId,
    eq(schema.conversation.isTest, false),
    isNull(schema.contact.sampleType),
    opts.includeArchived ? undefined : isNull(schema.contact.archivedAt),
    opts.since ? gt(schema.conversation.updatedAt, opts.since) : undefined
  );
}

export async function listConversations(
  organizationId: string,
  since?: Date,
  opts: { includeArchived?: boolean } = {}
): Promise<ConversationDto[]> {
  const db = getDb();
  const previewSql = sql<string | null>`(
    select coalesce(m.text, m.type)
    from message m
    where m.conversation_id = ${schema.conversation.id}
    order by m.created_at desc
    limit 1
  )`;
  const stageSql = sql<string | null>`(
    select s.name from lead l
    join pipeline_stage s on s.id = l.stage_id
    where l.contact_id = ${schema.contact.id}
    limit 1
  )`;
  // Bug reportado: un envío rechazado por Meta (131026, etc.) avanzaba
  // `lastMessageAt` igual que uno exitoso — el prospecto se quedaba sin nada
  // y la conversación no se veía "pendiente". Ver server/inbox/pending.ts.
  // 024: `delivery_unknown` (no se sabe si llegó) también pide atención humana.
  const lastMessageFailedSql = sql<boolean>`(
    select coalesce(m.direction = 'out' and m.status in ('failed', 'delivery_unknown'), false)
    from message m
    where m.conversation_id = ${schema.conversation.id}
    order by m.created_at desc
    limit 1
  )`;

  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      preview: previewSql,
      stageName: stageSql,
      lastMessageFailed: lastMessageFailedSql,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(conversationVisibilityWhere(organizationId, { since, ...opts }))
    .orderBy(desc(sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`));

  return rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      r.preview,
      r.stageName,
      r.lastMessageFailed
    )
  );
}

export async function getConversation(
  organizationId: string,
  conversationId: string
) {
  const db = getDb();
  const lastMessageFailedSql = sql<boolean>`(
    select coalesce(m.direction = 'out' and m.status in ('failed', 'delivery_unknown'), false)
    from message m
    where m.conversation_id = ${schema.conversation.id}
    order by m.created_at desc
    limit 1
  )`;
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      lastMessageFailed: lastMessageFailedSql,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(schema.message.createdAt);
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  lastMessageFailed = false
): ConversationDto {
  return {
    id: c.id,
    channel: c.channel,
    contact: {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      archivedAt: contact.archivedAt?.toISOString() ?? null,
    },
    stageName,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unreadCount: c.unreadCount,
    pendingReply: isPendingReply(
      c.lastInboundAt,
      c.lastMessageAt,
      new Date(),
      lastMessageFailed
    ),
    windowOpen: isWindowOpen(c.lastInboundAt),
    windowRemainingMs: windowRemainingMs(c.lastInboundAt),
    preview,
  };
}

export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean }
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.aiEnabled = patch.aiEnabled ?? true;
    // 023: reactivar la IA empieza de cero el conteo de fallos consecutivos.
    set.aiFailCount = 0;
    set.aiFailKind = null;
    set.aiFailAt = null;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  return updated[0] ?? null;
}
