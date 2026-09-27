import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  serializeTemplate,
  setWindowFallback,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Solo toca marcas LOCALES de la plantilla (hoy: la genérica fuera de
 * ventana). El cuerpo aprobado por Meta no se edita aquí: cambiarlo exige
 * volver a mandarlo a aprobación con `POST /api/templates`.
 */
const patchSchema = z.object({
  isWindowFallback: z.boolean(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  try {
    const template = await setWindowFallback(
      session.organizationId,
      id,
      body.data.isWindowFallback
    );
    return Response.json({ template: serializeTemplate(template) });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
