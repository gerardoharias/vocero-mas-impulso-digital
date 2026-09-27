import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { SendError, sendText } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

/**
 * Versión del contrato de respuesta de este endpoint. v1 (hasta 023): un fallo
 * temporal de Meta respondía 502/503. v2 (024): un fallo RECUPERABLE responde
 * `200` con `status: "retrying"`; un resultado ambiguo, `200` con
 * `status: "delivery_unknown"`. Sólo un rechazo definitivo sigue siendo error.
 */
const SEND_CONTRACT = 2;

const bodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4096),
});

/**
 * Envío del cerebro externo A TRAVÉS del CRM: el token de WhatsApp nunca sale
 * de aquí. Usa el mismo camino que el composer de la bandeja (`sendText`), así
 * que el mensaje queda en el hilo marcado como IA, respeta la ventana de 24 h
 * y hereda el guard de sandbox del Laboratorio.
 *
 * 409 tipados: ai_paused (un humano tomó la conversación) · window_closed ·
 * sandbox_violation.
 *
 * 024 — `200` = el mensaje quedó registrado. `status` dice en qué punto:
 * `pending`/`sent` (Meta lo aceptó) · `retrying` (fallo temporal: el CRM lo
 * reenvía SOLO, con el mismo texto) · `delivery_unknown` (no se sabe si llegó:
 * NO se reenvía solo; lo resuelve una persona en la bandeja). Un cerebro
 * externo jamás debe reenviar un 200. Ver docs/bot-messages-contrato.md.
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

  // Gate de handoff: el bot JAMÁS habla sobre una conversación pausada. Se
  // relee aquí porque entre que el bot pidió el contexto y armó su respuesta
  // (segundos de un LLM) el dueño pudo haber tomado la conversación.
  const db = getDb();
  const convs = await db
    .select({
      aiEnabled: schema.conversation.aiEnabled,
      handoffAt: schema.conversation.handoffAt,
    })
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
  if (!conv.aiEnabled || conv.handoffAt) {
    return apiError(409, "ai_paused", "La IA está en pausa en esta conversación");
  }

  try {
    const result = await sendText({
      conversationId: body.data.conversationId,
      organizationId,
      text: body.data.text,
      aiGenerated: true,
    });
    // Contrato v2 (spec 024): `200` significa "el mensaje EXISTE y el CRM se
    // encarga", no "ya llegó". Ver docs/bot-messages-contrato.md. Un cerebro
    // externo NO debe reenviar por su cuenta un 200: duplicaría.
    return Response.json(
      { messageId: result.messageId, status: result.status ?? null, contract: SEND_CONTRACT },
      { headers: { "X-Vocero-Send-Contract": String(SEND_CONTRACT) } }
    );
  } catch (err) {
    if (err instanceof SendError) {
      if (err.code === "window_closed") {
        return apiError(409, "window_closed", err.message);
      }
      if (err.code === "sandbox_violation") {
        return apiError(409, "sandbox_violation", err.message);
      }
      return apiError(502, err.code, err.message);
    }
    throw err;
  }
}
