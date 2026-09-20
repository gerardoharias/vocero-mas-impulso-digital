import { PROMPT_LEAK_MARKERS } from "@/server/ai/prompts";

/**
 * Red de rescate del turno del agente.
 *
 * Incidente del 2026-09-19: un prospecto preguntó algo fuera de tema y el
 * proveedor contestó BIEN ("solo me enfoco en temas de CRM… ¿seguimos con tu
 * demostración?") pero en PROSA, sin envolverla en JSON. `extractJson` la
 * descartó, se gastaron los 3 intentos, la conversación se escaló y al cliente
 * no le llegó nada: quedó colgado. Esto convierte esa prosa en el texto de un
 * `reply`, que es el mandato de CLAUDE.md — "un hipo del proveedor nunca tumba
 * el turno".
 *
 * Es deliberadamente CONSERVADORA: ante la duda devuelve `null` y el turno
 * escala CON aviso al cliente, que es un desenlace definido. Lo único
 * inaceptable es el silencio.
 *
 * Vive aquí y no en `lib/ai`: aquel adaptador es genérico sobre cualquier
 * esquema Zod (el juez del Laboratorio, la transcripción de audio) y no puede
 * asumir que exista una acción `reply`. Esto es política de dominio.
 */

/**
 * Tope en BYTES, no en caracteres. Por debajo del canal más estrecho
 * (Instagram, 1000 bytes — ver `server/channels/capabilities.ts`) con margen
 * para acentos y emojis.
 *
 * No es un límite de transporte, es un filtro de PLAUSIBILIDAD: una respuesta
 * de chat legítima son una o dos frases, y 900+ bytes de un modelo que YA
 * ignoró el contrato JSON casi siempre son un monólogo, un razonamiento
 * filtrado o el prompt regurgitado.
 *
 * Y por encima del tope se descarta, nunca se trunca: un mensaje cortado a
 * media frase puede partir un precio ("el precio es $1,2") — peor que escalar.
 */
const MAX_BYTES = 900;

/** Empieza como JSON, termina como JSON, o trae sus claves: son restos rotos. */
const JSONISH = /^[[{]|["'\s][}\]]\s*$|"action"\s*:|"reply"\s*:/;

/**
 * Eco de un error del proveedor. `callProvider` ya lanza ante un HTTP no-2xx,
 * así que esto solo atrapa al modelo que REPITE un error como si fuera su
 * respuesta. Cinturón y tirantes.
 */
const PROVIDER_NOISE =
  /^(error\b|internal server error|bad gateway|service unavailable|upstream|timeout|rate.?limit|too many requests|\{"error")/i;

/**
 * Devuelve el texto entregable al cliente, o `null` si no hay nada que se
 * pueda entregar con seguridad.
 *
 * @param raw El crudo del proveedor. `undefined` significa que nunca llegó a
 *   hablar (5xx, timeout, 429 agotado) — no hay nada que rescatar.
 */
export function salvageProse(raw: string | undefined): string | null {
  if (!raw) return null;

  let text = raw;

  // Modelos de razonamiento: el bloque <think> JAMÁS sale al cliente, pero lo
  // que viene después sí suele ser la respuesta buena.
  const think = text.lastIndexOf("</think>");
  if (think !== -1) text = text.slice(think + "</think>".length);

  // Un bloque de fences que NO era JSON (si lo fuera, extractJson ya lo habría
  // parseado con sus tres candidatos) sigue siendo prosa con markdown.
  const fence = text.match(/^\s*```(?:\w+)?\s*([\s\S]*?)```\s*$/);
  if (fence?.[1]) text = fence[1];

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (text.length < 2) return null;
  if (JSONISH.test(text)) return null;
  if (PROVIDER_NOISE.test(text)) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return null;
  if (PROMPT_LEAK_MARKERS.some((marker) => text.includes(marker))) return null;

  return text;
}
