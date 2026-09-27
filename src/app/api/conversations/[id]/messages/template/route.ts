import { z } from "zod";
import { MAX_TEMPLATE_BODY_CHARS } from "@/lib/templates";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { SendError } from "@/server/inbox/send";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  templateId: z.string().min(1),
  /**
   * Valores de {{1}}..{{n}} en orden. `variable` sigue vivo por compatibilidad.
   * Tope por valor = el del cuerpo entero: una plantilla genérica lleva en
   * {{1}} todo lo que el operador escribió. El largo real (cuerpo ya
   * renderizado ≤ 1024) lo valida `sendTemplate`, que dice cuánto sobra.
   */
  variables: z
    .array(z.string().trim().max(MAX_TEMPLATE_BODY_CHARS))
    .max(10)
    .optional(),
  variable: z.string().trim().max(500).optional(),
});

export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  try {
    const result = await sendTemplate({
      organizationId: session.organizationId,
      conversationId: id,
      templateId: body.data.templateId,
      variables:
        body.data.variables ??
        (body.data.variable === undefined ? undefined : [body.data.variable]),
    });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(403, err.code, err.message);
    }
    throw err;
  }
});
