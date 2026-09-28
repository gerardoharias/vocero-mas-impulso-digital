import { z } from "zod";
import { normalizeAgentActionInput } from "@/server/agenda/query-intent";

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
     * 025/026 — `offer_slots` YA NO lleva día: en cuanto el cliente nombra uno
     * (o una hora, o un rango) la acción es `check_availability`, que consulta
     * la agenda completa con SUS palabras en vez de fiarse de que el modelo
     * calcule la fecha. Dejar aquí un `day` que nadie consume sería peor que
     * no tenerlo: el modelo lo rellenaría y no pasaría nada.
     */
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
  /**
   * 025 — CONSULTA DIRECTA de disponibilidad. El modelo pasa lo que dijo el
   * prospecto (día, hora, rango o «el más tarde»); el servidor resuelve las
   * fechas y horas y responde con el motor evaluado sobre TODO lo pedido. Sin
   * `reply` a propósito: el modelo no redacta (ni afirma) nada sobre horarios.
   */
  z.object({
    action: z.literal("check_availability"),
    /** "mañana", "lunes", "25 de septiembre" o ISO. Omitido = todo el horizonte. */
    day: z.string().optional(),
    /**
     * 026 — Días ALTERNATIVOS cuando el cliente ofrece más de uno con «o»/«u»
     * ("jueves o viernes"), tope 3, en el orden en que los dijo. Mutuamente
     * excluyente con `day` (si mandas ambos, éste se ignora).
     */
    days: z.array(z.string()).optional(),
    /** Horas concretas, tal como las dijo: ["11", "12"], ["4 de la tarde"]. */
    times: z.array(z.string()).optional(),
    /** Rango: "entre las 3 y las 5 pm" → from "3 pm", to "5 pm". */
    from: z.string().optional(),
    to: z.string().optional(),
    /** «el más tarde» / «el más temprano». */
    edge: z.enum(["earliest", "latest"]).optional(),
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
    action.action === "check_availability" ||
    action.action === "request_reschedule"
  ) {
    // `check_availability` no lleva `reply`: si el motor falla, el pipeline
    // responde con un texto fijo (nunca una afirmación sobre horarios).
    if (action.action === "check_availability") return { action: "none" };
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  return action;
}

/**
 * Se aplica a la respuesta cruda del modelo ANTES de validar el esquema (opción
 * `normalize` de `chatJson`): `""`, espacios y `[]` de `check_availability` son
 * AUSENCIA. Ver `src/server/agenda/query-intent.ts`.
 */
export const normalizeAgentAction = normalizeAgentActionInput;
