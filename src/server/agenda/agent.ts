import { appBaseUrl } from "@/lib/env";
import { computeAvailability } from "@/server/agenda/availability";
import {
  getSettings,
  type CalendarSettings,
} from "@/server/agenda/settings";
import { renderWeeklyHours, type BusinessHours } from "@/server/agenda/hours";
import {
  pickAcrossDays,
  pickWithinDay,
  slotsOnDay,
  spreadByDay,
  type SpreadSlot,
} from "@/server/agenda/spread";
import { getOffers, replaceOffers } from "@/server/agenda/offers";
import {
  BookingError,
  createSessionBooking,
  findActiveBooking,
  listActiveBookings,
} from "@/server/agenda/service";
import {
  addDaysISO,
  dayLabelInTz,
  labelInTz,
  todayInTz,
} from "@/lib/time/slots";
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
        label: labelInTz(b.scheduledAt.toISOString(), settings.timezone),
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
  | "error";

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo; el turno sigue, sin agendar. */
  ok: boolean;
  status: AgendaTurnStatus;
};

/** Cuántos huecos del día pedido se registran como reservables. */
const DAY_OFFERED = 8;
/** Techo del catálogo persistido: varias rondas de "¿y el jueves?" no deben engordarlo sin fin. */
const OFFERS_CAP = 20;

type DayResolution =
  | { kind: "ok"; dayIso: string }
  | { kind: "out_of_window" }
  | { kind: "ignore" };

/**
 * Qué hacer con el `day` que mandó el modelo.
 *
 * Un día que no parsea se IGNORA (oferta normal) en vez de romper el turno: el
 * cliente recibe opciones, que es mejor que un error. Un día pasado o más allá
 * de `maxDaysAhead` sí se dice — y NO se "repara" buscando el mismo día-mes en
 * el futuro, porque adivinar aquí agenda al cliente en una fecha que no pidió.
 */
function resolveRequestedDay(
  day: string | undefined,
  settings: CalendarSettings,
  now: Date
): DayResolution {
  if (!day) return { kind: "ignore" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { kind: "ignore" };
  const parsed = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return { kind: "ignore" };
  const today = todayInTz(now, settings.timezone);
  const last = addDaysISO(today, settings.maxDaysAhead);
  if (day < today || day > last) return { kind: "out_of_window" };
  return { kind: "ok", dayIso: day };
}

function listar(shown: SpreadSlot[], intro: string | undefined): AgendaTurn {
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const cabecera = intro?.trim() || "Tengo estos horarios disponibles:";
  return { ok: true, status: "offered", text: `${cabecera}\n${lista}` };
}

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  /**
   * El día del que el cliente pidió horarios (YYYY-MM-DD, zona del negocio).
   * Con él se muestran varias HORAS de ESE día; sin él, el menú normal de
   * varios días. Incidente 2026-09-20.
   */
  day?: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
  });
  // El catálogo ancho se calcula SIEMPRE: es el que conserva los otros días
  // como alternativas legítimas aunque esta ronda vaya filtrada.
  const wide = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  if (wide.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    // La intro del modelo se DESCARTA: la escribió dando por hecho que habría
    // lista debajo, y pegarla sola ("Claro, aquí tienes horarios:") deja al
    // prospecto mirando una promesa vacía.
    return {
      ok: false,
      status: "no_availability",
      text: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  const pedido = resolveRequestedDay(input.day, settings, now);

  if (pedido.kind === "ignore") {
    await persistOffers(input, wide);
    // `wide` ya viene agrupado por día en orden cronológico: tomar los
    // primeros SHOWN a secas mostraría solo el primer día si ese día por sí
    // solo llena el menú. `pickAcrossDays` reparte por variedad primero.
    return listar(pickAcrossDays(wide, SHOWN), input.intro);
  }

  const delDia =
    pedido.kind === "ok"
      ? spreadByDay(slotsOnDay(all, pedido.dayIso, settings.timezone), {
          timezone: settings.timezone,
          limit: DAY_OFFERED,
          perDay: DAY_OFFERED,
          now,
        })
      : [];

  if (delDia.length === 0) {
    return await dayUnavailable(input, pedido, all, wide, settings, now);
  }

  // Los huecos que el cliente ACABA de ver se van al final: pidió otro horario
  // justamente porque esos no le servían. Sale del dato que el motor ya tiene
  // (la oferta vigente), sin pedirle un campo más al modelo.
  const yaVistos = new Set(
    (await getOffers(input.organizationId, input.conversationId)).map((o) =>
      Date.parse(o.startUtc)
    )
  );
  const ordenados = [...delDia].sort(
    (a, b) =>
      Number(yaVistos.has(Date.parse(a.startUtc))) -
      Number(yaVistos.has(Date.parse(b.startUtc)))
  );

  await persistOffers(input, [...wide, ...delDia]);
  return listar(pickWithinDay(ordenados, SHOWN), input.intro);
}

/** Registra el catálogo deduplicado por instante y ordenado, con techo. */
async function persistOffers(
  input: { organizationId: string; conversationId: string },
  slots: SpreadSlot[]
): Promise<void> {
  const porInstante = new Map<number, SpreadSlot>();
  for (const s of slots) porInstante.set(Date.parse(s.startUtc), s);
  const unicos = [...porInstante.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, OFFERS_CAP)
    .map(([, s]) => ({ startUtc: s.startUtc, label: s.label }));
  await replaceOffers(input.organizationId, input.conversationId, unicos);
}

/**
 * El día pedido no dio nada. Se dice con la fecha real y se ofrece lo más
 * cercano — nunca se escala ni se inventa una restricción de horario, que es
 * justo lo que pasó el 2026-09-20 ("las demostraciones las tenemos en horario
 * de mañana", que no salía de ninguna configuración).
 *
 * La intro del modelo se descarta por el mismo motivo que arriba: la escribió
 * creyendo que habría horarios de ese día.
 */
async function dayUnavailable(
  input: { organizationId: string; conversationId: string },
  pedido: DayResolution,
  all: Awaited<ReturnType<typeof computeAvailability>>,
  wide: SpreadSlot[],
  settings: CalendarSettings,
  now: Date
): Promise<AgendaTurn> {
  const tz = settings.timezone;
  const alternativaIso =
    pedido.kind === "ok"
      ? wide.find((s) => s.dayIso > pedido.dayIso)?.dayIso ?? wide[0]?.dayIso
      : wide[0]?.dayIso;
  const alternativa = alternativaIso
    ? spreadByDay(slotsOnDay(all, alternativaIso, tz), {
        timezone: tz,
        limit: DAY_OFFERED,
        perDay: DAY_OFFERED,
        now,
      })
    : [];

  if (alternativa.length === 0) {
    return {
      ok: false,
      status: "no_availability",
      text: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  const shown = pickWithinDay(alternativa, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const cabecera =
    pedido.kind === "out_of_window"
      ? `Solo puedo agendar entre hoy y el ${dayLabelInTz(
          `${addDaysISO(todayInTz(now, tz), settings.maxDaysAhead)}T12:00:00.000Z`,
          tz,
          now
        )}. Lo más cercano que tengo es:`
      : `Ese día no me queda nada libre. Lo más cercano que tengo es:`;

  await persistOffers(input, [...wide, ...alternativa]);
  return { ok: false, status: "day_unavailable", text: `${cabecera}\n${lista}` };
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
      return {
        ok: false,
        status: err.code === "slot_taken" ? "slot_taken" : "not_offered",
        text: `${disculpa}\n${lista}`,
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
