import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { transcribeAudio } from "@/lib/ai";
import { resolveAiConfig } from "@/server/ai/credentials";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import {
  getCredentialsByOrg,
  type Credentials,
} from "@/server/whatsapp/credentials";

/**
 * 008 — Única frontera de media con la Graph API (constitución II: todo el
 * tráfico a Meta pasa por adaptadores dedicados) + persistencia en el volumen
 * local `MEDIA_DIR`. Meta expira sus archivos (~30 días, URLs de minutos):
 * el disco propio es la copia durable que la UI previsualiza.
 */

export type MediaKind = (typeof schema.mediaAsset.$inferSelect)["kind"];

/** Límites de la Cloud API por tipo (validados ANTES de tocar red, FR-007). */
export const MEDIA_LIMITS: Record<
  Exclude<MediaKind, "location" | "contacts">,
  { maxBytes: number; mimes: RegExp; label: string }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: /^image\/(jpeg|png|webp)$/,
    label: "imagen (jpeg/png/webp, máx. 5 MB)",
  },
  sticker: {
    maxBytes: 100 * 1024,
    mimes: /^image\/webp$/,
    label: "sticker (webp, máx. 100 KB)",
  },
  audio: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^audio\/(aac|mp4|mpeg|amr|ogg|opus)/,
    label: "audio (aac/mp4/mpeg/amr/ogg, máx. 16 MB)",
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^video\/(mp4|3gpp)$/,
    label: "video (mp4/3gpp, máx. 16 MB)",
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    mimes: /^[\w.-]+\/[\w.+-]+$/,
    label: "documento (máx. 100 MB)",
  },
};

/** Clasifica un MIME de archivo saliente al tipo de mensaje de la Cloud API. */
export function kindFromMime(mime: string): "image" | "audio" | "video" | "document" {
  if (MEDIA_LIMITS.image.mimes.test(mime)) return "image";
  if (MEDIA_LIMITS.audio.mimes.test(mime)) return "audio";
  if (MEDIA_LIMITS.video.mimes.test(mime)) return "video";
  return "document";
}

export class MediaValidationError extends Error {
  code: "too_large" | "unsupported_type";
  constructor(code: MediaValidationError["code"], message: string) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

/**
 * Valida MIME y tamaño para envío; devuelve el kind resuelto. Los formatos
 * que WhatsApp no acepta como su tipo nativo (p. ej. image/bmp) van como
 * documento — igual que hace la app de WhatsApp.
 */
export function validateOutgoing(mime: string, sizeBytes: number) {
  if (!/^[\w.-]+\/[\w.+-]+$/.test(mime)) {
    throw new MediaValidationError("unsupported_type", "Tipo de archivo no reconocido");
  }
  const kind = kindFromMime(mime);
  const limit = MEDIA_LIMITS[kind];
  if (sizeBytes > limit.maxBytes) {
    throw new MediaValidationError(
      "too_large",
      `El archivo excede el límite de ${limit.label}`
    );
  }
  return kind;
}

/* ---------- Disco local ---------- */

function assertSafeSegment(s: string): void {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de ruta inválido: ${s}`);
}

/** Ruta absoluta del archivo de un asset dentro de MEDIA_DIR. */
export function mediaFilePath(organizationId: string, assetId: string): string {
  assertSafeSegment(organizationId);
  assertSafeSegment(assetId);
  return path.join(getEnv().MEDIA_DIR, organizationId, assetId);
}

export async function saveMediaFile(
  organizationId: string,
  assetId: string,
  data: Buffer | Uint8Array
): Promise<string> {
  const file = mediaFilePath(organizationId, assetId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return path.join(organizationId, assetId); // ruta relativa persistida en BD
}

export async function readMediaFile(
  organizationId: string,
  assetId: string
): Promise<Buffer> {
  return readFile(mediaFilePath(organizationId, assetId));
}

/* ---------- Descarga desde Graph (entrantes y echoes) ---------- */

type GraphMediaMeta = { url?: string; mime_type?: string; file_size?: number };

export class MediaFetchError extends Error {
  /** true si Meta ya no tiene el archivo (expirado/borrado) — no reintentar. */
  gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "MediaFetchError";
    this.gone = gone;
  }
}

/**
 * Descarga un media de Graph: GET {mediaId} → url efímera → GET con Bearer.
 * El token JAMÁS sale del servidor.
 */
export async function downloadGraphMedia(
  token: string,
  waMediaId: string,
  maxBytes: number = MEDIA_LIMITS.document.maxBytes
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  let meta: GraphMediaMeta;
  try {
    meta = await graphRequest<GraphMediaMeta>(waMediaId, { token });
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  if (meta.file_size && meta.file_size > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }

  let res: Response;
  try {
    res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok) {
    throw new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  return {
    data: buf,
    mimeType: meta.mime_type ?? res.headers.get("content-type"),
    fileSize: buf.byteLength,
  };
}

/**
 * Marca en `fetchError` un fallo DEFINITIVO (Meta ya no tiene el archivo:
 * 404/410, o excede el límite de tamaño). Sin columna nueva: el texto
 * legible sigue siendo el mismo para el operador, solo se le antepone un
 * prefijo que `ensureAssetAvailable` reconoce para NO reintentar.
 */
const GONE_PREFIX = "[definitivo] ";

function encodeFetchError(message: string, gone: boolean): string {
  return gone ? `${GONE_PREFIX}${message}` : message;
}

/** Texto legible sin el prefijo interno, para mostrar al operador. */
export function describeFetchError(error: string | null): string | null {
  if (!error) return null;
  return error.startsWith(GONE_PREFIX) ? error.slice(GONE_PREFIX.length) : error;
}

function isGoneFetchError(error: string | null): boolean {
  return error?.startsWith(GONE_PREFIX) ?? false;
}

/**
 * Garantiza que el asset esté en disco (`fetchStatus=available`).
 * Se usa en la descarga in-process post-ingesta Y on-demand desde la ruta de
 * media. Nunca lanza hacia el webhook: el que llama decide qué hacer con el
 * resultado. Devuelve el asset actualizado o null si no se pudo.
 *
 * `awaitTranscription` (default false): si el asset es audio sin `caption`,
 * por defecto la transcripción se dispara en segundo plano SIN esperarla (la
 * ruta on-demand de media solo quiere los bytes, ya). `scheduleMediaJob` la
 * pone en `true` para el disparo desde la ingesta, de forma que la promesa
 * que registra cubra descarga + transcripción de punta a punta.
 */
export async function ensureAssetAvailable(
  organizationId: string,
  assetId: string,
  opts?: { awaitTranscription?: boolean }
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(eq(schema.mediaAsset.id, assetId))
    .limit(1);
  const asset = rows[0];
  if (!asset || asset.organizationId !== organizationId) return null;
  if (asset.fetchStatus === "available") return asset;
  if (!asset.waMediaId) return null; // location/contacts no tienen binario
  // Bug reportado: cada vez que alguien abría el hilo, la ruta de media
  // reintentaba la descarga contra Graph aunque Meta YA hubiera confirmado
  // que el archivo expiró (404/410) — un reintento inútil por cada vista,
  // sin ningún camino a que algún día funcione.
  if (asset.fetchStatus === "failed" && isGoneFetchError(asset.fetchError)) {
    return asset;
  }

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) return null;

  try {
    const { data, mimeType, fileSize } = await downloadGraphMedia(
      creds.token,
      asset.waMediaId
    );
    const storagePath = await saveMediaFile(organizationId, assetId, data);
    const updated = await db
      .update(schema.mediaAsset)
      .set({
        storagePath,
        mimeType: asset.mimeType ?? mimeType,
        fileSize,
        fetchStatus: "available",
        fetchError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId))
      .returning();
    const result = updated[0] ?? null;
    if (result && result.kind === "audio" && !result.caption) {
      const transcription = transcribeAndCaption(
        assetId,
        data,
        result.mimeType ?? "audio/ogg",
        organizationId
      );
      if (opts?.awaitTranscription) {
        await transcription;
      } else {
        // Nunca bloquea la descarga ni el ingest (FR-013).
        void transcription;
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const gone = err instanceof MediaFetchError && err.gone;
    await db
      .update(schema.mediaAsset)
      .set({
        fetchStatus: "failed",
        fetchError: encodeFetchError(message, gone),
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId));
    console.warn(
      `[media] descarga del asset ${assetId} falló${gone ? " (definitivo, no se reintentará)" : ""}: ${message}`
    );
    return null;
  }
}

/**
 * En memoria, por proceso: job de descarga+transcripción en curso por asset.
 * El turno del agente (pipeline.ts) espera esta MISMA promesa vía
 * `awaitMediaJob` en vez de adivinar con polling o de responder antes de que
 * termine (bug 2026-09-16: el turno corría a los 6-8 s del coalesce, mucho
 * antes de que la descarga+transcripción real terminaran, y respondía con el
 * marcador "sin transcripción" incluso cuando el audio era perfectamente
 * entendible).
 */
const globalForMediaJobs = globalThis as unknown as {
  __mediaJobs?: Map<string, Promise<void>>;
};
function mediaJobs(): Map<string, Promise<void>> {
  if (!globalForMediaJobs.__mediaJobs) globalForMediaJobs.__mediaJobs = new Map();
  return globalForMediaJobs.__mediaJobs;
}

/** Dispara descarga+transcripción de un asset sin bloquear al llamador, y
 * registra la promesa combinada para que `awaitMediaJob` la pueda esperar. */
export function scheduleMediaJob(organizationId: string, assetId: string): void {
  const job = ensureAssetAvailable(organizationId, assetId, {
    awaitTranscription: true,
  })
    .then(() => undefined)
    .catch(() => undefined);
  mediaJobs().set(assetId, job);
  void job.finally(() => {
    if (mediaJobs().get(assetId) === job) mediaJobs().delete(assetId);
  });
}

/**
 * Espera el job de descarga+transcripción de un asset, acotado a `timeoutMs`.
 * Sin job en curso en ESTE proceso (ya terminó, o nunca se disparó desde
 * aquí — p. ej. tras un reinicio) resuelve de inmediato: el llamador decide
 * qué hacer según el estado que lea después en BD.
 */
export async function awaitMediaJob(
  assetId: string,
  timeoutMs: number
): Promise<void> {
  const job = mediaJobs().get(assetId);
  if (!job) return;
  await Promise.race([job, sleep(timeoutMs)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 018 — Transcribe la nota de voz y la deja en `caption` (WhatsApp nunca
 * pone caption en audio, así que el campo está libre): el agente
 * (historyAsChatMessages) y la bandeja la muestran como si fuera texto del
 * mensaje, sin tabla nueva. Un hipo del proveedor deja el asset sin
 * transcripción — nunca sin audio ni rompe nada más — pero ahora SIEMPRE
 * queda un motivo legible en `transcribeError` y en logs (antes se perdía en
 * silencio: `if (!result.ok) return;` sin registrar nada).
 */
async function transcribeAndCaption(
  assetId: string,
  data: Buffer,
  mimeType: string,
  organizationId: string
): Promise<void> {
  // El modelo de transcripción y el token salen de Ajustes → IA de ESTE
  // negocio; sin fila configurada, `resolveAiConfig` devuelve {} y
  // `transcribeAudio` cae a las variables de entorno.
  const aiConfig = await resolveAiConfig(organizationId, {
    transcribe: true,
  }).catch(() => ({}));
  const result = await transcribeAudio({ data, mimeType, aiConfig });
  const db = getDb();

  async function findMessage() {
    const msgRows = await db
      .select({
        id: schema.message.id,
        organizationId: schema.message.organizationId,
        conversationId: schema.message.conversationId,
      })
      .from(schema.message)
      .where(eq(schema.message.mediaAssetId, assetId))
      .limit(1);
    return msgRows[0] ?? null;
  }

  if (!result.ok) {
    console.warn(
      `[media] transcripción del asset ${assetId} sin resultado: ${result.error}`
    );
    await db
      .update(schema.mediaAsset)
      .set({ transcribeError: result.error, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));
    // Bug reportado: un fallo de transcripción no avisaba a nadie en vivo —
    // solo quedaba en logs del servidor. El operador con el hilo abierto se
    // quedaba sin saber por qué Max "no entendió" el audio hasta refrescar.
    const msg = await findMessage();
    if (msg) {
      publish(msg.organizationId, {
        type: "message.media",
        data: {
          conversationId: msg.conversationId,
          messageId: msg.id,
          caption: null,
          transcribeError: result.error,
        },
      });
    }
    return;
  }
  await db
    .update(schema.mediaAsset)
    .set({ caption: result.text, transcribeError: null, updatedAt: new Date() })
    .where(eq(schema.mediaAsset.id, assetId));

  const msg = await findMessage();
  if (!msg) return;
  publish(msg.organizationId, {
    type: "message.media",
    data: {
      conversationId: msg.conversationId,
      messageId: msg.id,
      caption: result.text,
      transcribeError: null,
    },
  });
}

/* ---------- Subida a Graph (salientes) ---------- */

/**
 * Sube un archivo a Graph (`POST /{phone_number_id}/media`, multipart) y
 * devuelve el media id para usar en /messages. Errores → MetaApiError (la
 * capa de envío los traduce con las mismas reglas que el texto).
 */
export async function uploadGraphMedia(
  credentials: Credentials,
  file: { data: Buffer | Uint8Array; mimeType: string; fileName?: string }
): Promise<string> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  const bytes = new Uint8Array(file.data);
  form.set(
    "file",
    new Blob([bytes], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.token}` },
      body: form,
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  const id = (json as { id?: string })?.id;
  if (!id) {
    throw new MetaApiError("Meta no devolvió ID del media subido", {
      status: res.status,
    });
  }
  return id;
}
