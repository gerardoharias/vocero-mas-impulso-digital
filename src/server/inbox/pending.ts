/**
 * "Pendiente de responder" (distinto de "no leída", FR-XXX pendiente de
 * numerar). `unreadCount` solo dice si alguien vio el mensaje en el CRM; no
 * dice si el prospecto YA recibió una respuesta. Un turno del agente que
 * falla en silencio (proveedor caído, envío que revienta después de aceptado
 * por Meta, etc.) puede dejar un entrante sin ninguna salida detrás aunque el
 * operador ya haya abierto el hilo y el badge de "no leídas" marque 0.
 *
 * Se deriva de columnas que YA existen (sin migración): `lastInboundAt` y
 * `lastMessageAt` se fijan al mismo instante en cada entrante (ingest.ts) y
 * SOLO `lastMessageAt` avanza en un saliente (send.ts) — si siguen iguales,
 * nada salió después del último entrante.
 */

/**
 * Margen antes de marcar "pendiente": el coalesce del agente
 * (`AGENT_COALESCE_MS`, 6s por defecto) más el viaje al proveedor LLM y sus
 * reintentos necesitan unos segundos normales de por medio. Marcar pendiente
 * de inmediato produciría una alerta falsa en CADA mensaje entrante mientras
 * el turno todavía está en curso.
 */
export const PENDING_REPLY_THRESHOLD_MS = 2 * 60_000;

export function isPendingReply(
  lastInboundAt: Date | null,
  lastMessageAt: Date | null,
  now: Date = new Date(),
  /**
   * true cuando el ÚLTIMO mensaje es un saliente con `status: "failed"` (o
   * `delivery_unknown`, spec 024: no se sabe si llegó y no se reenvía solo)
   * (bug reportado: un envío rechazado por Meta -p. ej. 131026- avanzaba
   * `lastMessageAt` igual que uno exitoso, así que "ya salió algo después
   * del entrante" quedaba en true aunque el prospecto no hubiera recibido
   * NADA). Un fallo de envío ya es un desenlace definitivo: no espera el
   * margen de abajo.
   */
  lastMessageFailed = false
): boolean {
  if (!lastInboundAt) return false;
  if (lastMessageFailed) return true;
  // Ya hubo un saliente estrictamente después del último entrante.
  if (lastMessageAt && lastMessageAt.getTime() > lastInboundAt.getTime()) {
    return false;
  }
  return now.getTime() - lastInboundAt.getTime() > PENDING_REPLY_THRESHOLD_MS;
}
