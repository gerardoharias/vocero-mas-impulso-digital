import { appBaseUrl } from "@/lib/env";
import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { renderWeeklyHours, type BusinessHours } from "@/server/agenda/hours";
import { pickAcrossDays, spreadByDay } from "@/server/agenda/spread";
import type { OfferedSlot } from "@/server/agenda/offers";
import {
  queryAvailability,
  type AvailabilityMeta,
  type AvailabilityQuery,
} from "@/server/agenda/availability-query";
import type {
  AgendaClarifyContext,
  AgendaClarifyReason,
  WeekQualifier,
} from "@/server/agenda/agenda-clarify-context";
import {
  BookingError,
  createSessionBooking,
  findActiveBooking,
  listActiveBookings,
} from "@/server/agenda/service";
import { labelInTz } from "@/lib/time/slots";
import { requestReschedule } from "@/server/agenda/reschedule-requests";

/**
 * 015 — Lo que el agente incluido puede hacer con la agenda.
 *
 * Vive aquí y no en el pipeline para que el pipeline no aprenda de agendas: el
 * turno pide "ofrece" o "reserva" y recibe el texto que hay que mandar.
 *
 * Regla que atraviesa las dos operaciones: el modelo NO redacta horarios. Pide
 * ofrecer, y el motor pega las etiquetas reales. Si el modelo inventa un
 * instante al reservar, el motor lo rechaza y se re-ofrece — nunca se agenda
 * algo que el cliente no eligió.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje. */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;

/**
 * Incidente 2026-09-19 — el dueño canceló una cita desde la pantalla de Citas
 * y, al siguiente "hola", el agente se la recordó igual. No era terquedad del
 * modelo: NO tenía ningún dato de citas en su contexto y estaba repitiendo su
 * propio "¡Listo! Te agendé para el lunes a las 09:00", que sigue en el
 * historial. Éste es el dato que faltaba.
 *
 * `unknown` NO es un lujo: si la lectura falla, degradar a "no tiene cita"
 * sería afirmar algo falso, solo que al revés. La única salida honesta es "no
 * lo pude verificar".
 */
export type AgendaState =
  | { kind: "none" }
  | { kind: "active"; bookings: { label: string; startUtc: string }[] }
  | { kind: "unknown" };

/**
 * El horario de atención configurado, para que el modelo conteste con la
 * verdad a "¿tienen algo después de las 6?" en vez de inventarse una
 * restricción (incidente 2026-09-20). Nunca lanza: sin esto el bloque no se
 * emite y el modelo vuelve a no hablar de horarios.
 */
export async function readBusinessHours(
  organizationId: string,
  now?: Date
): Promise<BusinessHours | undefined> {
  try {
    const settings = await getSettings(organizationId);
    return renderWeeklyHours(settings, now ?? new Date());
  } catch (err) {
    console.warn(`[agenda] no pude leer el horario de atención: ${err}`);
    return undefined;
  }
}

/**
 * El estado real de citas del contacto, para inyectarlo en el prompt. Nunca
 * lanza: un fallo del motor degrada el turno, jamás lo tumba.
 */
export async function readAgendaState(input: {
  organizationId: string;
  contactId: string;
  /** El Laboratorio mira SU sandbox; una conversación real, las citas reales. */
  isTest: boolean;
  now?: Date;
}): Promise<AgendaState> {
  try {
    const rows = await listActiveBookings(input.organizationId, input.contactId, {
      isTest: input.isTest,
      now: input.now,
    });
    if (rows.length === 0) return { kind: "none" };
    // getSettings solo se paga cuando SÍ hay cita: el caso común (sin cita)
    // cuesta una query, no dos.
    const settings = await getSettings(input.organizationId);
    return {
      kind: "active",
      bookings: rows.map((b) => ({
        // El MISMO helper que produjo la etiqueta que el cliente ya vio al
        // agendar: si no coincidiera letra por letra, el modelo podría creer
        // que son dos citas distintas.
        label: labelInTz(b.scheduledAt.toISOString(), settings.timezone, {
          hour12: true,
        }),
        startUtc: b.scheduledAt.toISOString(),
      })),
    };
  } catch (err) {
    console.warn(`[agenda] no pude leer el estado de citas del contacto: ${err}`);
    return { kind: "unknown" };
  }
}

/**
 * Auditoría 2026-09-17 — el DESENLACE exacto del turno de agenda, para que
 * quien llame (pipeline.ts, los tests) distinga sin ambigüedad "se agendó" de
 * "ya había una cita", "hay un cambio pendiente", "el hueco se ocupó" o
 * "falló": nunca disfrazar un bloqueo o un error de confirmación.
 */
export type AgendaTurnStatus =
  | "booked"
  | "offered"
  | "no_availability"
  /** El DÍA que pidió el cliente no dio nada (cerrado, lleno o fuera de ventana). */
  | "day_unavailable"
  | "existing_booking"
  | "reschedule_pending"
  | "slot_taken"
  | "not_offered"
  /** 025 — respuesta a una consulta directa de disponibilidad. */
  | "availability"
  /** 025 — la consulta no se pudo interpretar: se pregunta, no se afirma nada. */
  | "availability_clarify"
  | "error";

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo; el turno sigue, sin agendar. */
  ok: boolean;
  status: AgendaTurnStatus;
  /**
   * 024 — Los horarios REGISTRABLES que este texto muestra (el catálogo, más
   * ancho que el menú). NO se escriben aquí: quien envía el mensaje los
   * persiste junto con él y quedan `pending` hasta que Meta lo acepta, porque
   * un horario "ofrecido" que el prospecto nunca vio no es seleccionable.
   */
  offers?: OfferedSlot[];
  /**
   * 025 — ¿La lista que se le mostró al prospecto es parcial o completa?
   * (`exhaustive`, `hasMore`, `total`…). Nadie debe deducir «no hay» de una lista
   * que declara `hasMore`.
   */
  availability?: AvailabilityMeta;
  /**
   * 026 — presente SÓLO cuando `status === "availability_clarify"`: por qué
   * no se pudo resolver y qué se entendió, para que el pipeline decida si
   * hereda el contexto en el turno siguiente o escala a un humano.
   */
  clarify?: { reason: AgendaClarifyReason; context: AgendaClarifyContext | null };
};

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
  });
  const spread = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  if (spread.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    return {
      ok: false,
      status: "no_availability",
      // La intro del modelo se DESCARTA: la escribió dando por hecho que habría
      // lista debajo, y pegarla sola ("Claro, aquí tienes horarios:") deja al
      // prospecto mirando una promesa vacía.
      text: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
      // El horizonte se evaluó COMPLETO y no hay nada: aquí sí es una negación honesta.
      availability: {
        kind: "suggestions",
        scopeComplete: true,
        exhaustive: true,
        hasMore: false,
        total: 0,
        conveyed: 0,
      },
    };
  }

  // Se REGISTRA todo el catálogo, no solo lo que se enseña: si el cliente pide
  // otro día, el agente tiene alternativas legítimas que aceptar. (024: el
  // registro lo hace el envío, ligado al mensaje; aquí sólo se calcula.)
  // `spread` ya viene agrupado por día en orden cronológico: tomar los
  // primeros SHOWN a secas mostraría solo el primer día si ese día por sí
  // solo llena el menú. `pickAcrossDays` reparte por variedad primero.
  const shown = pickAcrossDays(spread, SHOWN);
  // `shown` marca lo que el TEXTO enseña: es lo único que se revalida si el
  // mensaje hay que reenviarlo (spec 024 §5.6).
  const shownStarts = new Set(shown.map((s) => s.startUtc));
  const offers = spread.map((s) => ({
    startUtc: s.startUtc,
    label: s.label,
    shown: shownStarts.has(s.startUtc),
  }));
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
  return {
    ok: true,
    status: "offered",
    text: `${intro}\n${lista}`,
    offers,
    // Son SUGERENCIAS, no la agenda: `total` es la cuenta completa del horizonte
    // y `hasMore` avisa que hay más de lo que se enseña (025 §4).
    availability: {
      kind: "suggestions",
      scopeComplete: true,
      exhaustive: all.length <= shown.length,
      hasMore: all.length > shown.length,
      total: all.length,
      conveyed: shown.length,
    },
  };
}

/**
 * 025 — Consulta DIRECTA: el prospecto indicó un día, una hora o un rango. La
 * respuesta sale del motor evaluado sobre todo lo pedido (no de las primeras
 * opciones mostradas) y NO escribe nada: devuelve el texto y los horarios, que
 * `sendText` persiste `pending` con el mensaje (024 §5.6).
 */
export async function checkAvailability(input: {
  organizationId: string;
  conversationId: string;
  query: AvailabilityQuery;
  /** 026 — calificador de semana heredado de una aclaración pendiente (regla 10). */
  impliedWeekModifier?: WeekQualifier;
  /** 026 — 1 = primera vez que se pregunta esto; ≥2 = ya se preguntó antes. */
  priorClarifyAttempt?: number;
}): Promise<AgendaTurn> {
  const answer = await queryAvailability({
    organizationId: input.organizationId,
    query: input.query,
    impliedWeekModifier: input.impliedWeekModifier,
    priorClarifyAttempt: input.priorClarifyAttempt,
  });
  return {
    ok: answer.ok,
    status: answer.status,
    text: answer.text,
    offers: answer.offers.length > 0 ? answer.offers : undefined,
    availability: answer.meta,
    clarify: answer.clarify,
  };
}

export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  confirmation?: string;
  /** Fase 5 — motivo breve tomado de la conversación; ver actions.ts. */
  reason?: string;
  /**
   * Auditoría 2026-09-17 — true SOLO si el modelo marcó EXPLÍCITAMENTE que
   * esto es una reunión aparte de cualquier cita activa del contacto (ver
   * `actions.ts`). Sin esto, una segunda cita activa se bloquea sola.
   */
  confirmAdditional?: boolean;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
      notes: input.reason?.trim() || null,
      allowAdditional: input.confirmAdditional === true,
      // 024 §5.7: si el hueco se ocupó, las alternativas NO se registran aquí
      // como `active`: viajan con el mensaje (`turn.offers`) y quedan `pending`.
      registerAlternatives: false,
    });

    const base =
      input.confirmation?.trim() || `¡Listo! Te agendé para ${result.label}.`;
    // La página de confirmación se lee SIEMPRE en vivo desde la cita real
    // (public-view.ts): si el enlace de reunión llega después (linkPending) o
    // la cita se mueve o se cancela, quien abra este link ve el estado actual
    // — nunca datos de cuando se mandó el mensaje.
    const confirmationUrl = `${appBaseUrl()}/cita/${result.booking.id}`;
    const guardar = `Guárdala en tu calendario (Google, Outlook o .ics): ${confirmationUrl}`;
    if (result.meetingLink) {
      return {
        ok: true,
        status: "booked",
        text: `${base}\nEnlace: ${result.meetingLink}\n${guardar}`,
      };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return {
        ok: true,
        status: "booked",
        text: `${base}\nEn un momento te comparto el enlace por aquí.\n${guardar}`,
      };
    }
    return { ok: true, status: "booked", text: `${base}\n${guardar}` };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Auditoría 2026-09-17 — el contacto ya tiene una cita activa: se dice
    // explícito, con la fecha real, y NUNCA se confirma nada nuevo. El
    // cliente decide si quiere moverla (request_reschedule) o si de verdad es
    // otra reunión (confirmAdditional).
    if (err.code === "existing_booking") {
      const cuando = err.existing?.label ?? "una fecha que ya tienes agendada";
      return {
        ok: false,
        status: "existing_booking",
        text: `Veo que ya tienes una cita agendada para ${cuando}. Cuéntame si quieres moverla o si esta es una reunión aparte.`,
      };
    }

    // Auditoría 2026-09-17 — hay un cambio de horario pendiente: no se agenda
    // nada nuevo hasta que ese pedido se resuelva de verdad (reprogramar
    // real), sin importar de qué esté hablando la conversación ahora.
    if (err.code === "reschedule_pending") {
      return {
        ok: false,
        status: "reschedule_pending",
        text: "Ya tomé nota del cambio de horario que pediste; en cuanto el equipo lo confirme te aviso por aquí.",
      };
    }

    // Se ocupó o el modelo inventó la hora: en ambos casos se re-ofrece con
    // datos reales en vez de discutir con el cliente.
    if (err.slots.length > 0) {
      const lista = err.slots
        .slice(0, SHOWN)
        .map((s) => `• ${s.label}`)
        .join("\n");
      const disculpa =
        err.code === "slot_taken"
          ? "Se me acaba de ocupar ese horario, ¡perdón!"
          : "Déjame confirmarte los horarios que tengo:";
      // Mismo contrato que `offer_slots` (spec 024 §5.6): el mensaje lleva sus
      // horarios; `shown` marca los que el TEXTO enseña (los primeros SHOWN).
      const offers = err.slots.map((s, i) => ({
        startUtc: s.startUtc,
        label: s.label,
        shown: i < SHOWN,
      }));
      return {
        ok: false,
        status: err.code === "slot_taken" ? "slot_taken" : "not_offered",
        text: `${disculpa}\n${lista}`,
        offers,
        // Alternativas cercanas: una muestra, no la agenda.
        availability: {
          kind: "suggestions",
          scopeComplete: false,
          exhaustive: false,
          hasMore: true,
          total: err.slots.length,
          conveyed: Math.min(err.slots.length, SHOWN),
        },
      };
    }
    return {
      ok: false,
      status: "error",
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}

/**
 * Auditoría 2026-09-17 — registra que el cliente pidió mover una cita, como
 * estado PERSISTENTE (`booking_change_request`), y lo devuelve para que
 * `pipeline.ts` derive a un humano: el agente incluido no tiene una
 * herramienta de reprogramación segura, así que este pedido NUNCA agenda
 * nada por su cuenta — solo dice que ya quedó anotado.
 *
 * Best-effort en la persistencia (igual que el resto de los efectos
 * secundarios de este módulo): si falla, el turno igual deriva a un humano —
 * quedarse callado o, peor, seguir agendando, sería el desenlace real malo.
 */
export async function recordRescheduleRequest(input: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  note?: string;
}): Promise<AgendaTurn> {
  try {
    const active = await findActiveBooking(input.organizationId, input.contactId);
    await requestReschedule({
      organizationId: input.organizationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      originalBookingId: active?.id ?? null,
      note: input.note,
    });
  } catch (err) {
    console.error(`[agenda] no pude registrar la solicitud de cambio: ${err}`);
  }
  return {
    ok: true,
    status: "reschedule_pending",
    text: "Voy a confirmar el cambio de horario con el equipo y te aviso por aquí.",
  };
}
