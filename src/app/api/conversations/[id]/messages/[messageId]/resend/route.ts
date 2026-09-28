import { apiError, withAuth } from "@/lib/api";
import { getConversation } from "@/server/inbox/queries";
import { resendText, SendError } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; messageId: string }> };

const SEND_ERROR_STATUS: Record<SendError["code"], number> = {
  sandbox_violation: 403,
  not_connected: 409,
  reconnect_required: 409,
  window_closed: 409,
  meta_error: 422,
  meta_unavailable: 503,
  upload_failed: 502,
  // 024: la oferta ya no es vigente / otro operador ya reenvió: conflicto de estado.
  offer_stale: 409,
  resend_conflict: 409,
};

/**
 * 024 — Reenvío MANUAL de un mensaje `failed` o `delivery_unknown`: el MISMO
 * payload persistido, en la MISMA burbuja, con UN intento (sin reintentos
 * automáticos posteriores). Es la decisión del operador de asumir el riesgo de
 * duplicado cuando no se sabe si el original llegó (`delivery_unknown`).
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id, messageId } = await ctx.params;
  const conversation = await getConversation(session.organizationId, id);
  if (!conversation) return apiError(404, "not_found", "Conversación no encontrada");

  try {
    const result = await resendText({
      messageId,
      organizationId: session.organizationId,
      conversationId: id,
    });
    return Response.json({ messageId: result.messageId, status: result.status ?? null });
  } catch (err) {
    if (err instanceof SendError) {
      return apiError(SEND_ERROR_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }
});
