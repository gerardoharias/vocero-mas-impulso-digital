import { z } from "zod";
import { getEnv, isAiConfigured } from "@/lib/env";

/**
 * Adaptador LLM OpenRouter-compatible — ÚNICA frontera con el proveedor de IA
 * (Constitución II). Regla operativa: la salida del modelo es impredecible;
 * todo consumo pasa por extracción robusta + Zod + reintentos, y un hipo del
 * proveedor jamás propaga excepción (resultado `error` tipado).
 */

/** 018: parte multimodal de un mensaje — hoy solo la usa la transcripción de audio. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

export type ChatJsonResult<T> =
  | { ok: true; data: T; raw: string }
  | {
      ok: false;
      error: "not_configured" | "provider_error" | "invalid_output";
      detail: string;
      /**
       * Contenido CRUDO y COMPLETO de la última respuesta CON contenido del
       * proveedor. Su AUSENCIA es información: significa que el proveedor
       * nunca llegó a hablar (5xx, 429 agotado, timeout, respuesta vacía —
       * `callProvider` lanza antes de devolver texto), o sea que no hay nada
       * que rescatar.
       *
       * Este adaptador NO decide qué hacer con él: es genérico sobre cualquier
       * esquema Zod (lo usan el juez del Laboratorio y la transcripción) y no
       * puede asumir que existe una acción `reply`. Esa política vive en
       * `server/ai/salvage.ts`.
       */
      raw?: string;
    };

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** Lanzada cuando el proveedor responde 429; carga el `Retry-After` si vino. */
class RateLimitError extends Error {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Semáforo global en proceso: techa cuántas llamadas al proveedor corren a la
 * vez (protege la factura ante ráfagas de conversaciones). Sin cola externa
 * (constitución II): un array de resolvers alcanza para un monolito.
 */
const globalForAi = globalThis as unknown as {
  __aiActive?: number;
  __aiQueue?: (() => void)[];
  /** Modelos que rechazaron `response_format` (ver callProvider). */
  __aiNoJsonMode?: Set<string>;
};
function acquireSlot(): Promise<() => void> {
  globalForAi.__aiActive ??= 0;
  globalForAi.__aiQueue ??= [];
  const release = () => {
    globalForAi.__aiActive!--;
    const next = globalForAi.__aiQueue!.shift();
    if (next) next();
  };
  const max = getEnv().AI_MAX_CONCURRENT_REQUESTS;
  if (globalForAi.__aiActive! < max) {
    globalForAi.__aiActive!++;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    globalForAi.__aiQueue!.push(() => {
      globalForAi.__aiActive!++;
      resolve(release);
    });
  });
}

export async function chatJson<T>(
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts?: {
    model?: string;
    judge?: boolean;
    timeoutMs?: number;
    /** Token de organización: pisa `OPENROUTER_API_TOKEN` cuando se pasa. */
    apiToken?: string;
  }
): Promise<ChatJsonResult<T>> {
  const orgToken = opts?.apiToken?.trim();
  // isAiConfigured() lee process.env en vivo (no el getEnv() cacheado): sin
  // token de organización, un token de entorno que cambie en runtime debe
  // notarse en la siguiente llamada, no quedar pegado al primer valor leído.
  if (!orgToken && !isAiConfigured()) {
    return {
      ok: false,
      error: "not_configured",
      detail: "Sin OPENROUTER_API_TOKEN configurado",
    };
  }
  const env = getEnv();
  const apiToken = orgToken || env.OPENROUTER_API_TOKEN;
  const model =
    opts?.model ??
    (opts?.judge
      ? (env.OPENROUTER_JUDGE_MODEL ?? env.OPENROUTER_MODEL)
      : env.OPENROUTER_MODEL);
  if (!model?.trim()) {
    return {
      ok: false,
      error: "not_configured",
      detail: "Sin OPENROUTER_MODEL configurado",
    };
  }

  const release = await acquireSlot();
  try {
    let lastDetail = "";
    // El raw del ÚLTIMO intento que trajo contenido. Queda `undefined` si el
    // proveedor nunca habló: ese hueco es el que distingue "fallo real" de
    // "el modelo contestó, pero con otro formato" (ver ChatJsonResult).
    let lastRaw: string | undefined;
    // Se asigna donde se CONOCE la causa. Antes se adivinaba buscando las
    // palabras "esquema"/"JSON" en el mensaje de error, y un 500 del proveedor
    // con cuerpo `{"error":"Invalid JSON in request"}` se contaba como culpa
    // del modelo.
    let lastError: "provider_error" | "invalid_output" = "provider_error";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptMessages: ChatMessage[] =
        attempt === 1
          ? messages
          : [
              ...messages,
              {
                role: "system",
                // Agnóstico del esquema a propósito: por aquí pasan también el
                // juez del Laboratorio y la transcripción de audio.
                content:
                  attempt === 2
                    ? "STRICT: tu respuesta anterior NO fue un objeto JSON válido según el esquema. Responde ÚNICAMENTE el objeto JSON: empieza por { y termina en }, sin markdown, sin explicaciones y sin una sola palabra fuera de él."
                    : "ÚLTIMO INTENTO. Devuelve SOLO el objeto JSON. Nada antes, nada después.",
              },
            ];
      try {
        const raw = await callProvider(
          model,
          attemptMessages,
          opts?.timeoutMs,
          apiToken
        );
        lastRaw = raw;
        const extracted = extractJson(raw);
        if (extracted === null) {
          lastError = "invalid_output";
          lastDetail = `sin JSON extraíble (raw=${truncate(raw)})`;
          continue;
        }
        const parsed = schema.safeParse(extracted);
        if (!parsed.success) {
          lastError = "invalid_output";
          lastDetail = `no cumple el esquema: ${parsed.error.issues
            .map((i) => i.path.join(".") + " " + i.message)
            .join("; ")} (raw=${truncate(raw)})`;
          continue;
        }
        return { ok: true, data: parsed.data, raw };
      } catch (err) {
        lastError = "provider_error";
        lastDetail = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) {
          const delay =
            err instanceof RateLimitError && err.retryAfterMs !== null
              ? err.retryAfterMs
              : RETRY_DELAY_MS * attempt;
          await sleep(delay);
        }
      }
    }

    return { ok: false, error: lastError, detail: lastDetail, raw: lastRaw };
  } finally {
    release();
  }
}

/** El proveedor rechazó `response_format` porque ESTE modelo no lo soporta. */
class JsonModeUnsupportedError extends Error {}

/**
 * Formas en que llega el rechazo del modo JSON. OpenRouter delega en el
 * proveedor real detrás del modelo, así que no hay un código único:
 *   404 "No endpoints found that support JSON mode"
 *   400 "response_format is not supported" / "unsupported parameter"
 *   422 '"response_format" is not supported'   (vLLM, Ollama, LM Studio)
 *   400 "'messages' must contain the word 'json'"  (guard estilo OpenAI)
 * Un 429 o un 5xx NUNCA se clasifican aquí: esos son caídas de verdad.
 */
const JSON_MODE_STATUSES = new Set([400, 404, 415, 422, 501]);
const JSON_MODE_REJECT =
  /response_format|json[_\s-]?object|json mode|must contain the word/i;

/** Modelos que ya rechazaron `response_format`: se deja de mandárselo. */
function jsonModeAllowed(model: string): boolean {
  return !globalForAi.__aiNoJsonMode?.has(model);
}
function rememberNoJsonMode(model: string): void {
  (globalForAi.__aiNoJsonMode ??= new Set()).add(model);
}

/**
 * Pide el JSON por contrato de API (`response_format`) en vez de fiarlo solo a
 * que el modelo obedezca el prompt, y si el modelo no lo soporta reintenta sin
 * él y lo recuerda: una llamada extra UNA vez por modelo y proceso.
 *
 * Se usa `json_object` y no `json_schema` a propósito: la variante estricta
 * exigiría derivar un JSON Schema de la unión discriminada de acciones, y
 * buena parte de los modelos de OpenRouter la rechazan.
 */
async function callProvider(
  model: string,
  messages: ChatMessage[],
  timeoutMs = 60_000,
  apiToken?: string,
  jsonMode = true
): Promise<string> {
  if (jsonMode && jsonModeAllowed(model)) {
    try {
      return await postCompletion(model, messages, timeoutMs, apiToken, true);
    } catch (err) {
      if (!(err instanceof JsonModeUnsupportedError)) throw err;
      rememberNoJsonMode(model);
      console.warn(
        `[ia] ${model} no acepta response_format json_object: se reintenta sin él y no se vuelve a mandar (${err.message})`
      );
    }
  }
  return postCompletion(model, messages, timeoutMs, apiToken, false);
}

async function postCompletion(
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  apiToken: string | undefined,
  jsonMode: boolean
): Promise<string> {
  const env = getEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.OPENROUTER_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        // El token jamás se loguea; solo viaja en este header.
        Authorization: `Bearer ${apiToken ?? env.OPENROUTER_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new RateLimitError(
          `proveedor respondió 429: ${truncate(text)}`,
          parseRetryAfter(res.headers.get("retry-after"))
        );
      }
      if (
        jsonMode &&
        JSON_MODE_STATUSES.has(res.status) &&
        JSON_MODE_REJECT.test(text)
      ) {
        throw new JsonModeUnsupportedError(
          `json_object rechazado (${res.status}): ${truncate(text)}`
        );
      }
      throw new Error(`proveedor respondió ${res.status}: ${truncate(text)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("respuesta del proveedor sin contenido");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 022 — Prueba un token + modelo ANTES de guardarlos: una llamada real y
 * barata al proveedor (un mensaje trivial, sin exigir JSON). Igual que el
 * wizard de WhatsApp o el conector de Zoom, credenciales que no sirven jamás
 * llegan a la base.
 */
export async function testAiCredentials(input: {
  apiToken: string;
  model: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callProvider(
      input.model,
      [{ role: "user", content: "Responde solo con la palabra: ok" }],
      15_000,
      input.apiToken,
      // Esta sonda pide texto plano a propósito: exigirle JSON haría que un
      // token perfectamente bueno pareciera roto.
      false
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const transcriptSchema = z.object({ text: z.string() });

/** Deriva el `format` de input_audio del mime del adjunto (ej. audio/ogg → ogg). */
function audioFormatFromMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a")) return "mp4";
  if (m.includes("aac")) return "aac";
  if (m.includes("amr")) return "amr";
  return "ogg"; // formato por defecto de las notas de voz de WhatsApp
}

/**
 * 018 — Transcribe una nota de voz reusando el MISMO proveedor OpenRouter-
 * compatible del agente (constitución II: sin proveedor de terceros nuevo).
 * Solo funciona si el modelo configurado acepta audio en chat completions;
 * si no, el proveedor falla y esto degrada a "sin transcripción" — nunca
 * bloquea la descarga del adjunto ni el turno del agente.
 */
export async function transcribeAudio(input: {
  data: Buffer;
  mimeType: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!isAiConfigured()) return { ok: false, error: "not_configured" };
  const env = getEnv();
  const model = env.OPENROUTER_TRANSCRIBE_MODEL ?? env.OPENROUTER_MODEL;
  if (!model?.trim()) return { ok: false, error: "not_configured" };

  const result = await chatJson(
    transcriptSchema,
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              'Transcribe este audio a texto plano en el idioma en que se habló, tal cual se dijo, sin resumir ni traducir. Si no hay voz entendible, responde con text vacío. Responde ÚNICAMENTE el JSON {"text":"..."}.',
          },
          {
            type: "input_audio",
            input_audio: {
              data: input.data.toString("base64"),
              format: audioFormatFromMime(input.mimeType),
            },
          },
        ],
      },
    ],
    { model, timeoutMs: 45_000 }
  );
  if (!result.ok) return { ok: false, error: result.detail };
  const text = result.data.text.trim();
  if (!text) return { ok: false, error: "sin voz entendible" };
  return { ok: true, text };
}

/**
 * Extracción robusta de JSON de una respuesta de modelo:
 * 1) bloque ```json ... ``` (o ``` ... ```), 2) el texto completo,
 * 3) del primer `{` al último `}`.
 */
export function extractJson(raw: string): unknown | null {
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(raw.trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // siguiente candidato
    }
  }
  return null;
}

/** `Retry-After` viene en segundos o como fecha HTTP; null si falta o es basura. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
