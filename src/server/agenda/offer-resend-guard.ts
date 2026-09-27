import { computeAvailability } from "@/server/agenda/availability";
import {
  checkOfferFreshness,
  markOfferStale,
  type StaleReason,
} from "@/server/agenda/offer-freshness";

/**
 * 024 — Guard del REENVÍO MANUAL de un mensaje que mostró horarios.
 *
 * Es una acción del operador, así que —a diferencia de un reintento automático—
 * SÍ puede consultar la disponibilidad actual: el operador va a asumir que esos
 * horarios siguen libres. Reglas (todas deben cumplirse):
 *   1. la ronda no fue sustituida, reservada ni marcada obsoleta;
 *   2. no existe una ronda de horarios posterior en la conversación;
 *   3. ningún horario mostrado venció ni está ocupado por una cita o bloqueo;
 *   4. el motor de disponibilidad de HOY todavía ofrece cada horario mostrado.
 *
 * Es de sólo lectura salvo por marcar OBSOLETA la ronda cuando la causa es
 * definitiva (venció, se ocupó, ya no se ofrece): jamás toca la ronda vigente,
 * no crea mensajes, no ejecuta IA ni `offer_slots`, y nunca envía horarios
 * "parciales": o sale el payload original completo, o no sale nada.
 *
 * @returns `null` si se puede reenviar (o si el mensaje no es una oferta); la
 *          causa del bloqueo en otro caso.
 */
export async function blockReasonForManualResend(
  messageId: string,
  opts: { now?: Date } = {}
): Promise<StaleReason | null> {
  const check = await checkOfferFreshness(messageId, opts);
  if (!check.applies) return null;

  if (!check.ok) {
    if (check.reason === "expired" || check.reason === "occupied") {
      await markOfferStale(messageId);
    }
    return check.reason;
  }

  const available = await computeAvailability(check.organizationId, {
    now: opts.now,
  });
  const offeredNow = new Set(available.map((s) => Date.parse(s.startUtc)));
  if (check.shownStarts.some((start) => !offeredNow.has(Date.parse(start)))) {
    await markOfferStale(messageId);
    return "unavailable";
  }
  return null;
}
