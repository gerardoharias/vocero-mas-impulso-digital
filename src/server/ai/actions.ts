import { z } from "zod";

/**
 * Acción tipada del agente: exactamente UNA por turno (FR-021).
 * El servidor valida cada acción contra sus allowlists (etapas de la org);
 * lo que no valida se degrada, nunca se ejecuta a ciegas.
 */
const baseActions = [
  z.object({ action: z.literal("none") }),
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({
    action: z.literal("update_lead"),
    /**
     * Auditoría 2026-09-17 (incidente GRojas) — UN hecho atómico y nuevo que
     * el cliente acaba de confirmar, nunca un resumen acumulado de todo lo
     * dicho hasta ahora. Acotado a propósito: obliga a que sea una frase, no
     * un párrafo que reescriba la conversación entera.
     */
    note: z.string().trim().min(1).max(300),
    /**
     * Giro/tema breve de ESTE hecho (p. ej. "plomería", "clínica dental").
     * Sin esto, el servidor no puede distinguir "este contacto sigue
     * hablando del mismo negocio" de "alguien está probando/preguntando por
     * uno distinto con el mismo teléfono" — y sin esa distinción, dos giros
     * incompatibles terminan mezclados en la misma ficha. Omítelo solo si de
     * verdad no aplica (p. ej. una nota logística que no depende del giro).
     */
    scenario: z.string().trim().min(1).max(80).optional(),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
  }),
] as const;

/**
 * 015 — Las dos acciones de agenda. Solo se registran si esta instancia tiene
 * la bandera encendida: donde no hay agenda, el modelo ni siquiera puede
 * nombrarlas.
 *
 * `reply` es una introducción opcional, NO la lista de horarios: los horarios
 * los pega el motor con las etiquetas reales. Y `startUtc` tiene que ser
 * exactamente uno de los que el sistema ofreció — si no, el motor lo rechaza y
 * se re-ofrece.
 */
const agendaActions = [
  z.object({
    action: z.literal("offer_slots"),
    /**
     * Incidente 2026-09-20 — el día del que el cliente pidió horarios
     * (YYYY-MM-DD, zona del negocio). Sin este campo, un cliente que decía
     * "el miércoles pero no a las 9" recibía EXACTAMENTE los mismos tres
     * horarios: el modelo no tenía cómo pedir otra cosa.
     *
     * Se COPIA del índice "DÍAS CON HORARIOS" que viaja en el contexto; el
     * modelo no calcula fechas (mismo motivo por el que existe el mapa
     * `label → startUtc`).
     *
     * El esquema NO valida el formato a propósito: `resolveRequestedDay` en
     * el motor ignora lo que no parezca una fecha y ofrece el menú normal. Un
     * regex aquí tiraría la acción entera por un campo opcional mal escrito,
     * gastaría los 3 reintentos de chatJson y podría acabar escalando — que
     * sería reproducir el incidente por otra vía.
     */
    day: z.string().optional(),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("book_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
    /**
     * Fase 5 (auditoría 2026-09) — resumen breve de POR QUÉ agenda, tomado de
     * lo que el cliente realmente dijo (nunca inventado): "cotizar taladros",
     * "seguimiento de propuesta". Se guarda en `booking.notes` y se muestra en
     * Citas como "Motivo". Opcional: sin esto, Citas simplemente no muestra
     * motivo para esa cita — nunca se rellena con un texto genérico.
     */
    reason: z.string().trim().min(1).max(200).optional(),
    /**
     * Auditoría 2026-09-17 — SOLO true cuando el cliente pidió, de forma
     * clara y aparte, una reunión DISTINTA a una cita activa que ya tiene (no
     * moverla, no la misma: otra). Sin esto en true, el servidor bloquea solo
     * una segunda cita para el mismo contacto — no basta con que tú lo
     * infieras de la conversación; si lo marcas, `reason` es OBLIGATORIO y
     * debe explicar por qué es aparte.
     */
    confirmAdditional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("request_reschedule"),
    reply: z.string().optional(),
    /**
     * Auditoría 2026-09-17 — resumen breve de qué cambio pidió el cliente,
     * tomado literalmente de la conversación (ej. "mover jueves 10am a
     * viernes"). Queda como constancia de la solicitud.
     */
    note: z.string().trim().min(3).max(200).optional(),
  }),
] as const;

export const AgentAction = z.discriminatedUnion("action", [
  ...baseActions,
  ...agendaActions,
]);

/** El esquema que se le exige al modelo en ESTE turno. */
export function agentActionSchema(agenda: boolean) {
  return agenda
    ? AgentAction
    : z.discriminatedUnion("action", [...baseActions]);
}

export type AgentActionType = z.infer<typeof AgentAction>;

/**
 * Resuelve el nombre de etapa devuelto por el modelo contra las etapas reales
 * de la organización (exacto → lower-case). Sin match: degradar a reply/none.
 */
export function resolveStage(
  requested: string,
  stages: { id: string; name: string }[]
): { id: string; name: string } | null {
  const exact = stages.find((s) => s.name === requested.trim());
  if (exact) return exact;
  const lower = requested.trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === lower) ?? null;
}

/** Degrada una acción que no se pudo ejecutar (FR-021 / contrato ai.md). */
export function degradeAction(action: AgentActionType): AgentActionType {
  if (
    action.action === "move_stage" ||
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "request_reschedule"
  ) {
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  return action;
}
