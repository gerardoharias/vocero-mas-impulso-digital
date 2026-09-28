import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

/**
 * 022 — Credenciales del proveedor LLM por organización.
 *
 * Mismo cifrado que WhatsApp/Zoom/Google. Sin fila para la organización,
 * `resolveAiConfig` cae a las variables de entorno — así una instancia que
 * nunca tocó esta pantalla sigue funcionando igual que antes de que existiera.
 */

export type AiCreds = {
  token: string;
  model: string;
  judgeModel: string | null;
  /** Modelo que transcribe notas de voz; null ⇒ reusa `model`. */
  transcribeModel: string | null;
  status: "connected" | "error";
};

const globalForAi = globalThis as unknown as {
  __aiCredsCache?: Map<string, AiCreds | null>;
};

function cache(): Map<string, AiCreds | null> {
  if (!globalForAi.__aiCredsCache) globalForAi.__aiCredsCache = new Map();
  return globalForAi.__aiCredsCache;
}

export async function getAiCredentials(
  organizationId: string
): Promise<AiCreds | null> {
  if (cache().has(organizationId)) return cache().get(organizationId)!;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.aiCredentials)
    .where(scoped(schema.aiCredentials.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  const creds: AiCreds | null = row
    ? {
        token: decryptSecret({
          cipher: row.tokenCipher,
          iv: row.tokenIv,
          tag: row.tokenTag,
        }),
        model: row.model,
        judgeModel: row.judgeModel,
        transcribeModel: row.transcribeModel,
        status: row.status,
      }
    : null;
  cache().set(organizationId, creds);
  return creds;
}

export async function saveAiCredentials(input: {
  organizationId: string;
  token: string;
  model: string;
  judgeModel?: string | null;
  transcribeModel?: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const values = {
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    model: input.model,
    judgeModel: input.judgeModel?.trim() ? input.judgeModel.trim() : null,
    transcribeModel: input.transcribeModel?.trim()
      ? input.transcribeModel.trim()
      : null,
    status: "connected" as const,
  };
  await db
    .insert(schema.aiCredentials)
    .values({
      id: newId("aiCredentials"),
      organizationId: input.organizationId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.aiCredentials.organizationId],
      set: { ...values, updatedAt: new Date() },
    });
  cache().delete(input.organizationId);
}

export async function deleteAiCredentials(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.aiCredentials)
    .where(scoped(schema.aiCredentials.organizationId, organizationId));
  cache().delete(organizationId);
}

/**
 * Marca la conexión como rota. Se escribe en el momento en que el proveedor
 * rechaza el token: si nadie lo escribiera, el dueño se enteraría por el
 * agente que dejó de responder, sin saber por qué.
 */
export async function markAiError(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.aiCredentials)
    .set({ status: "error", updatedAt: new Date() })
    .where(scoped(schema.aiCredentials.organizationId, organizationId));
  cache().delete(organizationId);
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}

/**
 * Config efectiva para una llamada al proveedor: la fila de la organización
 * si existe, si no las variables de entorno (comportamiento de hoy).
 */
export async function resolveAiConfig(
  organizationId: string,
  opts?: { judge?: boolean }
): Promise<{ apiToken?: string; model?: string }> {
  const creds = await getAiCredentials(organizationId);
  if (!creds) return {};
  const model = opts?.judge ? (creds.judgeModel ?? creds.model) : creds.model;
  return { apiToken: creds.token, model };
}

/**
 * Config para TRANSCRIBIR notas de voz.
 *
 * Devuelve los dos modelos POR SEPARADO a propósito. Resolverlos aquí con un
 * `transcribeModel ?? model` fue un error real (2026-09-28): la organización
 * tenía fila con `model = z-ai/glm-5.3-flash` y `transcribe_model` vacío, así
 * que el modelo del AGENTE ganaba y tapaba `OPENROUTER_TRANSCRIBE_MODEL`, que
 * estaba bien configurada. El audio seguía muriendo con 404.
 *
 * La escalera correcta la aplica `transcribeAudio`, y pone lo DEDICADO
 * primero venga de donde venga: panel → entorno → modelo del agente. Usar el
 * modelo del agente para audio casi siempre es lo que NO se quiere.
 */
export async function resolveTranscribeConfig(organizationId: string): Promise<{
  apiToken?: string;
  transcribeModel?: string;
  model?: string;
}> {
  const creds = await getAiCredentials(organizationId);
  if (!creds) return {};
  return {
    apiToken: creds.token,
    transcribeModel: creds.transcribeModel ?? undefined,
    model: creds.model,
  };
}
