import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { testAiCredentials } from "@/lib/ai";
import { effectiveAiModels } from "@/lib/ai/config";
import {
  deleteAiCredentials,
  getAiCredentials,
  saveAiCredentials,
  tokenLast4,
} from "@/server/ai/credentials";

export const dynamic = "force-dynamic";

/**
 * 022 — Token + modelo del proveedor LLM, por organización. El token entra,
 * pero nunca vuelve a salir: hacia el navegador solo van sus últimos 4.
 */

export const GET = withAuth(async (session) => {
  const creds = await getAiCredentials(session.organizationId);
  // 023: los modelos EFECTIVOS (de dónde sale cada uno), para verificar en
  // producción qué identificador se usa exactamente — sin ningún token.
  const effective = effectiveAiModels(
    creds ? { model: creds.model, judgeModel: creds.judgeModel } : null
  );
  if (!creds) return Response.json({ connection: null, effective });
  return Response.json({
    effective,
    connection: {
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
      model: creds.model,
      judgeModel: creds.judgeModel,
    },
  });
});

const credsSchema = z.object({
  token: z.string().trim().min(1),
  model: z.string().trim().min(1),
  judgeModel: z.string().trim().optional(),
});

/** Guarda validando ANTES contra el proveedor: un token que no sirve no llega a la base. */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, credsSchema);
  if (!body.ok) return body.response;

  const check = await testAiCredentials({
    apiToken: body.data.token,
    model: body.data.model,
  });
  if (!check.ok) return apiError(422, "ai_invalid", check.error);

  await saveAiCredentials({
    organizationId: session.organizationId,
    ...body.data,
  });

  return Response.json({
    connection: {
      status: "connected",
      tokenLast4: tokenLast4(body.data.token),
      model: body.data.model,
      judgeModel: body.data.judgeModel?.trim() || null,
    },
  });
});

export const DELETE = withAuth(async (session) => {
  await deleteAiCredentials(session.organizationId);
  return Response.json({ ok: true });
});
