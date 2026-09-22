import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { markReadAndTyping } from "@/server/whatsapp/presence";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ conversationId: z.string().min(1) });

/**
 * Indicador "escribiendo…" + marcar leído el último inbound.
 * POST /api/bot/typing {conversationId}
 *
 * Best-effort por contrato: al bot JAMÁS le vale reintentar esto — si Meta
 * falla se responde 200 {ok:false} y la conversación sigue. El indicador
 * dura hasta ~25 s o hasta que llegue la respuesta real.
 *
 * Motivos posibles de {ok:false}: sandbox, channel_unsupported, ai_paused,
 * no_inbound, meta_error. `no_connection` sale como 409, no como {ok:false}.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const convs = await db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  const conv = convs[0];
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");

  // La lógica vive en `server/whatsapp/presence.ts` porque el agente
  // in-process la necesita igual, y desde ahí no se puede llamar a un route.
  // Este handler conserva lo suyo: la API key, el tenant, el 404 y el 409.
  const result = await markReadAndTyping({ conversation: conv });
  if (!result.ok && result.reason === "no_connection") {
    // Se mantiene como 409 y no como {ok:false}: es contrato publicado.
    return apiError(409, "no_connection", "WhatsApp no está conectado");
  }
  return Response.json(result);
}
