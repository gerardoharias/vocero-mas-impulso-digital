import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { aiFallbackMessage, getEnv } from "@/lib/env";
import { chatJson, type ChatJsonResult, type ChatMessage } from "@/lib/ai";
import { createCallBudget, type CallBudget } from "@/lib/ai/budget";
import { resolveEffectiveModel } from "@/lib/ai/config";
import { errorClass } from "@/lib/ai/errors";
import { describeError, logAi } from "@/lib/ai/log";
import { markAiError, resolveAiConfig } from "@/server/ai/credentials";
import {
  CIRCUIT,
  circuitCheck,
  circuitRecordFailure,
  circuitRecordSuccess,
  countsTowardCircuit,
  type CircuitGate,
} from "@/server/ai/circuit";
import {
  CONSECUTIVE_FORMAT_FAILURES_LIMIT,
  circuitNoticeRecent,
  markCircuitNotice,
  recordFormatFailure,
  resetFailureState,
} from "@/server/ai/failure-state";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  normalizeAgentAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { conversationAllowsAgent } from "@/server/ai/eligibility";
import { markReadAndTyping, TYPING_TTL_MS } from "@/server/whatsapp/presence";
import {
  buildAgendaNowMessage,
  buildAgentSystemPrompt,
  rulesBlockOf,
} from "@/server/ai/prompts";
import { recoverPlainText } from "@/server/ai/recovery";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  bookSlot,
  checkAvailability,
  offerSlots,
  readAgendaState,
  readBusinessHours,
  recordRescheduleRequest,
  type AgendaTurn,
} from "@/server/agenda/agent";
import { claimsNoAvailability } from "@/server/agenda/availability-query";
import { guardAgendaAction } from "@/server/agenda/query-intent";
import {
  isUnambiguousTopicChange,
  mergeClarifyContext,
  nextAttemptNumber,
  recordUnresolvedAttempt,
} from "@/server/agenda/agenda-clarify-context";
import {
  loadAgendaClarifyState,
  resetAgendaClarifyState,
  writeAgendaClarifyState,
} from "@/server/agenda/agenda-clarify-state";
import {
  getOffers,
  offerDays,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import { awaitMediaJob } from "@/server/whatsapp/media";
import { recordAiNote } from "@/server/contacts/notes";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/** Punto de entrada con debounce (mensajes entrantes reales). */
export function scheduleAgentTurn(conversationId: string): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
  };
  map.set(conversationId, entry);

  if (entry.running) {
    entry.pending = true; // se re-encola al terminar el turno actual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  try {
    await runAgentTurn(conversationId);
  } catch (err) {
    // Sólo nombre/código: el mensaje de un error de BD o de Meta puede traer
    // parámetros con el texto o el teléfono del cliente.
    console.error(`[agente] turno falló: ${describeError(err)}`);
  } finally {
    entry.running = false;
    if (entry.pending) {
      entry.pending = false;
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

type HistoryRow = typeof schema.message.$inferSelect;

/** Descripción textual de un adjunto sin transcripción (bug: antes el turno
 * ni se enteraba de que había llegado algo — un cliente mandando SOLO notas
 * de voz nunca recibía respuesta). */
function mediaPlaceholder(
  kind: typeof schema.mediaAsset.$inferSelect["kind"]
): string {
  switch (kind) {
    case "audio":
      return "[nota de voz — sin transcripción disponible]";
    case "image":
      return "[imagen]";
    case "video":
      return "[video]";
    case "document":
      return "[documento]";
    case "sticker":
      return "[sticker]";
    case "location":
      return "[ubicación compartida]";
    case "contacts":
      return "[contacto compartido]";
  }
}

/**
 * Cuánto espera el turno, como máximo, a que termine la transcripción de una
 * nota de voz que llegó como último mensaje entrante ANTES de resignarse al
 * marcador "sin transcripción disponible". El coalesce (AGENT_COALESCE_MS,
 * 6-8 s) ya pasó cuando esto corre; descarga+transcripción reales casi
 * siempre tardan más que eso, así que sin esta espera el turno respondía
 * sistemáticamente antes de tiempo (bug 2026-09-16, Diego/MÁS Impulso: Max
 * decía "no pude escucharla" con audios perfectamente entendibles).
 */
const AUDIO_TRANSCRIBE_WAIT_MS = 20_000;

/** true si el asset de audio todavía no tiene un desenlace definitivo
 * (ni transcripción, ni fallo de transcripción, ni fallo de descarga). */
function audioStillPending(
  asset: typeof schema.mediaAsset.$inferSelect | undefined
): boolean {
  if (!asset) return false;
  if (asset.kind !== "audio") return false;
  if (asset.caption) return false;
  if (asset.transcribeError) return false;
  if (asset.fetchStatus === "failed") return false;
  return true;
}

/**
 * Si el último mensaje entrante es una nota de voz sin desenlace todavía,
 * espera (acotado) el job de descarga+transcripción registrado por la
 * ingesta (`scheduleMediaJob`) en vez de dejar que el turno responda de
 * inmediato con el marcador genérico. No lanza ni bloquea otras
 * conversaciones — solo retrasa ESTE turno, que ya tiene el lock del
 * coalesce.
 */
async function waitForAudioTranscription(
  conversationId: string,
  mediaAssetId: string
): Promise<void> {
  const db = getDb();
  const fetchAsset = async () => {
    const rows = await db
      .select()
      .from(schema.mediaAsset)
      .where(eq(schema.mediaAsset.id, mediaAssetId))
      .limit(1);
    return rows[0];
  };

  const before = await fetchAsset();
  if (!audioStillPending(before)) return;

  console.log(
    `[agente] esperando transcripción del audio ${mediaAssetId} antes de responder (conv ${conversationId})`
  );
  await awaitMediaJob(mediaAssetId, AUDIO_TRANSCRIBE_WAIT_MS);

  const after = await fetchAsset();
  if (audioStillPending(after)) {
    console.warn(
      `[agente] transcripción del audio ${mediaAssetId} no terminó en ${AUDIO_TRANSCRIBE_WAIT_MS}ms: respondo con el marcador genérico`
    );
  }
}

/**
 * Arma el historial para el LLM. Un mensaje sin `text` (adjunto) YA NO
 * desaparece del turno: entra con un marcador (o la transcripción, si 018 la
 * dejó en `media.caption`) para que el agente sepa que algo llegó en vez de
 * quedarse mudo.
 */
async function historyAsChatMessages(
  history: HistoryRow[]
): Promise<ChatMessage[]> {
  const mediaIds = history
    .map((m) => m.mediaAssetId)
    .filter((id): id is string => id !== null);
  const mediaById = new Map<string, typeof schema.mediaAsset.$inferSelect>();
  if (mediaIds.length > 0) {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.mediaAsset)
      .where(inArray(schema.mediaAsset.id, mediaIds));
    for (const row of rows) mediaById.set(row.id, row);
  }

  const out: ChatMessage[] = [];
  for (const m of history) {
    let content = m.text;
    if (!content && m.mediaAssetId) {
      const media = mediaById.get(m.mediaAssetId);
      if (media) content = media.caption || mediaPlaceholder(media.kind);
    }
    if (!content) continue;
    out.push({
      role: m.direction === "in" ? "user" : "assistant",
      content,
    });
  }
  return out;
}

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 */
export async function runAgentTurn(
  conversationId: string,
  opts?: {
    /**
     * Fase 6 — comportamiento SIN GUARDAR a probar (vista previa de Ajustes
     * → Agente, vía el Laboratorio). Nunca se aplica a una conversación
     * real: si `conversation.isTest` es false, se ignora — un turno real
     * jamás corre con instrucciones que el operador no publicó.
     */
    profileOverride?: Partial<
      Pick<
        typeof schema.agentProfile.$inferSelect,
        "name" | "tone" | "instructions" | "escalationRules" | "greeting"
      >
    >;
  }
): Promise<void> {
  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  // El predicado es compartido con `trigger.ts` a propósito: si divergieran,
  // el prospecto vería "escribiendo…" en una conversación que atiende una
  // persona.
  if (!conversationAllowsAgent(conversation)) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  let profile = profileRows[0];
  if (!profile) return;
  if (conversation.isTest && opts?.profileOverride) {
    profile = { ...profile, ...opts.profileOverride };
  }
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  const history = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  history.reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;

  // 024 (G5) — Un turno, una respuesta lógica. La respuesta a este entrante
  // lleva una clave única: si ya existe (el turno se re-ejecutó tras un
  // reinicio, o corrió dos veces), NO se vuelve a llamar al modelo ni a la
  // agenda. El Laboratorio no la usa (sus mensajes nunca salen). Esa respuesta
  // es más NUEVA que el entrante, así que ya viene en el historial de arriba
  // (sin otra consulta); la restricción UNIQUE de `message.dedupe_key` es la
  // garantía dura si dos turnos corrieran a la vez.
  const turnKey = conversation.isTest ? undefined : `agent-turn:${lastInbound.id}`;
  if (turnKey && history.some((m) => m.dedupeKey === turnKey)) {
    logAi("info", {
      event: "turn_outcome",
      traceId: conversation.id,
      outcome: "already_answered",
    });
    return;
  }

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await escalate(conversation, "ventana");
    return;
  }

  // Patrón de respaldo ANTES del LLM (FR-022).
  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await escalate(conversation, "cliente");
    return;
  }

  if (lastInbound.type === "audio" && lastInbound.mediaAssetId) {
    await waitForAudioTranscription(conversationId, lastInbound.mediaAssetId);
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();
  // Sin esto el modelo solo conoce la etiqueta humana ("mié 16 sep, 09:00")
  // que él mismo mandó al cliente, y tiene que ADIVINAR el instante UTC exacto
  // para book_slot — findOffered exige el epoch exacto (sin tolerancia, a
  // propósito), así que sin la lista real el agendado nunca cierra.
  // En paralelo: son dos lecturas independientes y en serie alargarían el
  // turno sin motivo.
  const [offers, agendaState, businessHours] = agenda
    ? await Promise.all([
        getOffers(organizationId, conversationId),
        // El estado REAL de citas. Sin esto el modelo no tenía ninguna fuente
        // de verdad y repetía su propio "te agendé" del historial aunque el
        // dueño hubiera cancelado la cita (incidente 2026-09-19).
        // `isTest` mantiene separados los dos mundos: el Laboratorio mira su
        // sandbox, una conversación real mira las citas del negocio.
        readAgendaState({
          organizationId,
          contactId: conversation.contactId,
          isTest: conversation.isTest,
        }),
        // Incidente 2026-09-20: sin el horario configurado, el modelo se
        // inventó una restricción ("solo atendemos por la mañana").
        readBusinessHours(organizationId),
      ])
    : [[], undefined, undefined];
  const agendaNow = buildAgendaNowMessage({
    agenda,
    agendaState,
    offers,
    offerDays: businessHours
      ? offerDays(offers, businessHours.timezone, new Date())
      : undefined,
  });
  const systemPrompt = buildAgentSystemPrompt({
    profile,
    kb,
    stages,
    agenda,
    businessHours,
    // Si ya le mandamos algo, esta conversación NO es nueva: el saludo sobra
    // (incidente 2026-09-25, tres "¡Hola! 👋" seguidos).
    esNueva: !history.some((m) => m.direction === "out"),
  });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(await historyAsChatMessages(history)),
    // El estado de AHORA va DESPUÉS del historial: es lo único que cambia
    // entre turnos y lo único que tiene que ganarle a lo que el propio agente
    // dijo veinte mensajes atrás. Ver buildAgendaNowMessage.
    ...(agendaNow ? [{ role: "system" as const, content: agendaNow }] : []),
  ];

  // Re-encender "escribiendo…" si la señal de la ingesta ya caducó (el
  // indicador de Meta expira a los ~25 s). Va AQUÍ y no antes: cada `return`
  // de más arriba significa que el agente no va a responder, y los puntitos
  // ahí serían una mentira. El wamid ya está en memoria: cero queries.
  // La conversación de prueba corta dentro del helper, antes de tocar la red.
  await markReadAndTyping({
    conversation,
    waMessageId: lastInbound.waMessageId,
    minIntervalMs: TYPING_TTL_MS,
  });

  const aiConfig = await resolveAiConfig(organizationId);
  const model = resolveEffectiveModel({ model: aiConfig.model });

  // Circuito de protección (spec 023 §3.7): si esta organización+modelo tiene
  // una falla GLOBAL en curso, este turno no gasta llamadas ni hace handoff.
  if (model) {
    const gate = circuitCheck(organizationId, model);
    if (!gate.allow) {
      await handleCircuitOpen(conversation, model, gate, turnKey);
      return;
    }
  }

  // UN presupuesto por turno, compartido por reintentos, escalera de formato,
  // corrección y recuperación de texto plano (spec 023 I1: ≤ 3 llamadas).
  const budget = createCallBudget();
  const result = await chatJson(agentActionSchema(agenda), messages, {
    ...aiConfig,
    traceId: conversationId,
    schemaName: "accion_agente",
    budget,
    // El texto plano (invalid_json) lo maneja la recuperación segura de abajo,
    // no una corrección genérica: ver spec 023 §3.4.
    correct: { invalidJson: false },
    // 025 rev.: `""`/`[]` = ausencia, ANTES de validar el esquema.
    normalize: normalizeAgentAction,
  });

  let action: AgentActionType;
  if (result.ok) {
    action = result.data;
    if (model) circuitRecordSuccess(organizationId, model);
    await clearFailureState(conversation);
  } else {
    const handled = await handleModelFailure({
      result,
      conversation,
      model,
      budget,
      rulesText: rulesBlockOf(systemPrompt),
      aiConfig,
      turnKey,
    });
    if (!handled) return;
    action = handled;
  }

  // 026 — texto del cliente desde la última respuesta (se usa para la compuerta
  // de agenda, la fusión de contexto de aclaración y la detección de cambio de
  // tema). Se calcula UNA vez, siempre, aunque esta instancia no tenga agenda.
  const lastOut = history.map((m) => m.direction).lastIndexOf("out");
  const customerText = history
    .slice(lastOut + 1)
    .filter((m) => m.direction === "in" && m.text)
    .map((m) => m.text as string)
    .join(" ");
  // 026 — memoria de aclaración de disponibilidad, cargada de la fila YA leída
  // de `conversation` (sin otra consulta): 0/null/null si no hay nada pendiente.
  const clarifyState = loadAgendaClarifyState(conversation);

  // 025 (rev. correctiva) — La compuerta de las acciones de agenda, con lo que el
  // CLIENTE escribió en este turno: `edge` sólo si lo pidió con esas palabras,
  // vacíos = ausencia, y `offer_slots` con un día/fecha/hora/rango en el mensaje
  // ES `check_availability` (aunque el perfil del negocio diga «usa offer_slots»).
  // No cambia nada más.
  if (agenda && (action.action === "offer_slots" || action.action === "check_availability")) {
    const guarded = guardAgendaAction(action, customerText);
    if (guarded.changes.length > 0) {
      action = guarded.action;
      logAi("info", {
        event: "action_guard",
        traceId: conversationId,
        outcome: guarded.changes.join("+"),
      });
    }
  }

  // 026 (regla 11-b) — Una aclaración de disponibilidad pendiente NO se limpia
  // sólo porque el modelo haya elegido, ESTE turno, una acción no relacionada
  // con agenda (eso solo no basta): hace falta ADEMÁS una señal determinista de
  // cambio de tema (`isUnambiguousTopicChange`, servidor). Si hay duda, se
  // conserva — un falso positivo sólo hace que se pregunte de más, nunca que
  // se invente disponibilidad.
  if (
    agenda &&
    clarifyState.count > 0 &&
    action.action !== "check_availability" &&
    action.action !== "offer_slots" &&
    action.action !== "book_slot" &&
    isUnambiguousTopicChange(customerText)
  ) {
    await resetAgendaClarifyState(conversation);
    clarifyState.count = 0;
    clarifyState.kind = null;
    clarifyState.context = null;
  }

  // 015 — Agenda. Un fallo del MOTOR degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  //
  // 024 (G1, G7) — SÓLO el motor va dentro del `try`. Antes, el envío también
  // estaba ahí: un rechazo temporal de Meta se confundía con "el motor falló",
  // `degradeAction` convertía `offer_slots` en la introducción sola y ESO era lo
  // que llegaba al prospecto (incidente 2026-09). Con el payload ya armado,
  // nada lo reconstruye ni lo sustituye: si el envío falla, el mensaje —íntegro—
  // queda en el outbox (reintento, `delivery_unknown` o `failed`).
  if (
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "check_availability"
  ) {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      let turn: AgendaTurn | null = null;
      try {
        turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
              })
            : action.action === "check_availability"
              ? await (() => {
                  // 026 — el turno actual manda; el contexto de una aclaración
                  // pendiente sólo RELLENA lo que falte (regla 10).
                  const merged = mergeClarifyContext(
                    clarifyState.context,
                    { day: action.day, days: action.days, times: action.times, from: action.from, to: action.to, edge: action.edge },
                    customerText
                  );
                  return checkAvailability({
                    organizationId,
                    conversationId,
                    query: merged.query,
                    impliedWeekModifier: merged.impliedWeekModifier,
                    priorClarifyAttempt: nextAttemptNumber(clarifyState),
                  });
                })()
              : await bookSlot({
                  organizationId,
                  conversationId,
                  startUtc: action.startUtc,
                  confirmation: action.reply,
                  reason: action.reason,
                  confirmAdditional: action.confirmAdditional,
                });
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${describeError(err)}`);
        // Sin `reply` que degradar: un texto fijo, sin afirmar nada de horarios.
        action =
          action.action === "check_availability"
            ? {
                action: "reply",
                text: "Tuve un problema al revisar la agenda. Lo confirmo con el equipo y te aviso por aquí.",
              }
            : degradeAction(action);
      }
      if (turn) {
        // 026 — memoria de aclaración: se actualiza ANTES de enviar, para que
        // un fallo de envío no deje el contador desincronizado del texto que
        // (con suerte) sí llegó en el reintento del outbox.
        let escalatedToHandoff = false;
        if (action.action === "check_availability" && turn.status === "availability_clarify" && turn.clarify) {
          const outcome = recordUnresolvedAttempt(clarifyState, turn.clarify.reason, turn.clarify.context);
          await writeAgendaClarifyState(conversation, clarifyState.count, outcome.state);
          if (outcome.escalate) {
            escalatedToHandoff = true;
            turn = {
              ...turn,
              text: "No logro ubicar bien la fecha después de varios intentos. Ya avisé al equipo para que te ayude directamente por aquí.",
            };
          }
        } else if (clarifyState.count > 0) {
          await resetAgendaClarifyState(conversation);
        }

        try {
          await deliverReply(conversation, turn.text, {
            turnKey,
            offers: turn.offers,
          });
        } catch (err) {
          // El fallo de envío ya quedó registrado en el mensaje (con su
          // estado y su payload íntegro). No hay nada que sustituir.
          console.error(
            `[agente] respuesta de agenda no entregada: ${describeError(err)}`
          );
        }
        if (escalatedToHandoff) {
          // 026 regla 15 — tres aclaraciones consecutivas sin resolver: se
          // deriva a un humano en vez de volver a preguntar.
          await applyHandoff(conversationId, organizationId, "agenda_ambigua");
        } else if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      }
    }
  }

  // Auditoría 2026-09-17 — el agente incluido no tiene una herramienta de
  // reprogramación segura (mover la cita ATÓMICAMENTE requiere saber a cuál
  // instante moverla y el modelo no elige eso aquí): se registra el pedido
  // como estado persistente y se deriva SIEMPRE a un humano. El traspaso se
  // aplica pase lo que pase con la persistencia — mismo criterio que el
  // "handoff" de abajo: nunca dejar al agente agendando por su cuenta sobre
  // una cita que el cliente pidió mover.
  if (action.action === "request_reschedule") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      const turn = await recordRescheduleRequest({
        organizationId,
        conversationId,
        contactId: conversation.contactId,
        note: action.note,
      });
      await applyHandoff(conversationId, organizationId, "reprogramacion");
      try {
        await deliverReply(conversation, action.reply?.trim() || turn.text, {
          turnKey,
        });
      } catch (err) {
        console.error(
          `[agente] traspaso por reprogramación aplicado pero el aviso no se pudo enviar: ${describeError(err)}`
        );
      }
      return;
    }
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) {
        await deliverReply(conversation, action.reply, { turnKey });
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply": {
      // 025 §5.4 — una NEGACIÓN de agenda escrita por el modelo («no tengo
      // horarios»), que sólo vio una lista parcial, no se envía: se sustituye por
      // lo que el motor dice de verdad (que puede ser, con evidencia, que no hay).
      if (agenda && claimsNoAvailability(action.text)) {
        let real: AgendaTurn | null = null;
        try {
          real = await checkAvailability({ organizationId, conversationId, query: {} });
        } catch (err) {
          console.error(`[agente] no pude verificar la agenda: ${describeError(err)}`);
        }
        if (real) {
          logAi("warn", {
            event: "turn_outcome",
            traceId: conversation.id,
            outcome: "availability_claim_replaced",
          });
          await deliverReply(conversation, real.text, { turnKey, offers: real.offers });
          return;
        }
      }
      await deliverReply(conversation, action.text, { turnKey });
      return;
    }
    case "update_lead": {
      await recordAiNote({
        organizationId,
        contactId: conversation.contactId,
        note: action.note,
        scenario: action.scenario ?? null,
        isTest: conversation.isTest,
        sourceMessageId: lastInbound.id,
      });
      if (action.reply) await deliverReply(conversation, action.reply, { turnKey });
      return;
    }
    case "handoff": {
      // El traspaso se PERSISTE antes de intentar la despedida (bug
      // reportado: si el envío fallaba después de que Meta ya había
      // aceptado el mensaje, la excepción se comía el applyHandoff de abajo
      // y el prospecto se quedaba "avisado" sin que el panel de Resultados ni
      // el estado de la conversación registraran el traspaso). Con el orden
      // invertido, el peor caso pasa a ser "se aplicó el traspaso pero la
      // despedida no salió" — nunca al revés.
      // Sin `farewell` el cliente ya no se queda mudo: escalate pone la
      // copia fija del sistema.
      await escalate(conversation, "modelo", { farewell: action.farewell });
      return;
    }
  }
}

type Conversation = typeof schema.conversation.$inferSelect;

/** Un turno con acción válida reinicia el conteo de fallos de la conversación (sin fallar el turno). */
async function clearFailureState(conversation: Conversation): Promise<void> {
  if (!(conversation.aiFailCount > 0) && !conversation.aiFailKind) return;
  try {
    await resetFailureState(conversation);
  } catch (err) {
    console.error(
      `[agente] no se pudo reiniciar el estado de fallos: ${describeError(err)}`
    );
  }
}

/**
 * Qué hacer cuando `chatJson` no entregó una acción válida (spec 023 §3.5).
 * Devuelve la acción a ejecutar (sólo `reply`, recuperado de texto plano) o
 * `null` si el turno ya quedó resuelto aquí (silencio, degradación o handoff).
 *
 * La clase del fallo decide — nunca el texto de un mensaje:
 * - config/transporte persistente → handoff "error" (política de siempre) y
 *   cuenta para el circuito de protección;
 * - formato → NO es un fallo del proveedor: recuperación de texto plano, o
 *   mensaje fijo de degradación, con la IA activa y la conversación viva.
 */
async function handleModelFailure(input: {
  result: Extract<ChatJsonResult<unknown>, { ok: false }>;
  conversation: Conversation;
  model: string | null;
  budget: CallBudget;
  rulesText: string;
  aiConfig: { apiToken?: string; model?: string };
  turnKey?: string;
}): Promise<AgentActionType | null> {
  const { result, conversation, model } = input;
  const traceId = conversation.id;
  if (result.error === "not_configured") return null;

  if (errorClass(result.error) !== "format") {
    // Fallo persistente del proveedor o incompatibilidad de configuración.
    let circuitOpened = false;
    if (model && countsTowardCircuit(result.error)) {
      circuitOpened = circuitRecordFailure(
        conversation.organizationId,
        model,
        conversation.id,
        result.error
      ).opened;
    }
    if (result.error === "unauthorized") {
      // Señal visible en Ajustes → IA (no-op si la org usa el token del entorno).
      try {
        await markAiError(conversation.organizationId);
      } catch (err) {
        console.error(
          `[agente] no se pudo marcar la conexión de IA: ${describeError(err)}`
        );
      }
    }
    logAi("error", {
      event: "turn_outcome",
      traceId,
      org: conversation.organizationId,
      model: model ?? undefined,
      code: result.error,
      status: result.status,
      outcome: circuitOpened ? "handoff_error_circuit_opened" : "handoff_error",
    });
    await applyHandoff(conversation.id, conversation.organizationId, "error");
    return null;
  }

  // El proveedor respondió: transporte y configuración funcionan (cierra una
  // racha o un turno de prueba del circuito). El formato es por mensaje.
  if (model) circuitRecordSuccess(conversation.organizationId, model);

  // Sólo si el borrador es la respuesta ORIGINAL del modelo (no la de una
  // corrección) y QUEDA presupuesto: 1 principal + 1 corrección O 1 principal
  // + 1 recuperación, dentro del tope de 3 llamadas por turno.
  if (
    result.error === "invalid_json" &&
    result.draft &&
    !result.meta?.corrected
  ) {
    const recovered = await recoverPlainText({
      draft: result.draft,
      rulesText: input.rulesText,
      aiConfig: input.aiConfig,
      traceId,
      budget: input.budget,
    });
    if (recovered.ok) {
      logAi("info", {
        event: "turn_outcome",
        traceId,
        outcome: "reply",
        recovered: "plain_text",
      });
      await clearFailureState(conversation);
      return { action: "reply", text: recovered.text };
    }
  }

  await degradeTurn(conversation, result.error, input.turnKey);
  return null;
}

/**
 * Degradación segura de un fallo de FORMATO: un mensaje fijo, sin promesas, y
 * la IA sigue activa. El conteo de fallos consecutivos vive en la base
 * (`recordFormatFailure`, atómico) y NO depende del texto que vio el cliente:
 * al segundo consecutivo el fallo ya no es aislado → handoff "error", sin
 * decirle nada más al cliente.
 */
async function degradeTurn(
  conversation: Conversation,
  code: string,
  turnKey?: string
): Promise<void> {
  let consecutive = 1;
  try {
    consecutive = await recordFormatFailure(conversation, code);
  } catch (err) {
    // Sin el contador se degrada (lo seguro): nunca se escala a ciegas.
    console.error(
      `[agente] no se pudo registrar el fallo de formato: ${describeError(err)}`
    );
  }
  if (consecutive >= CONSECUTIVE_FORMAT_FAILURES_LIMIT) {
    logAi("error", {
      event: "turn_outcome",
      traceId: conversation.id,
      code,
      failures: consecutive,
      outcome: "handoff_error_consecutive",
    });
    await applyHandoff(conversation.id, conversation.organizationId, "error");
    return;
  }
  logAi("warn", {
    event: "turn_outcome",
    traceId: conversation.id,
    code,
    failures: consecutive,
    outcome: "degraded",
  });
  try {
    await deliverReply(conversation, aiFallbackMessage(), { turnKey });
  } catch (err) {
    console.error(
      `[agente] mensaje de degradación no enviado: ${describeError(err)}`
    );
  }
}

/**
 * Circuito abierto: sin llamadas al proveedor y SIN handoff (la IA sigue
 * activa: la conversación es recuperable cuando el circuito cierre). El cliente
 * recibe UNA vez por periodo el mensaje fijo de degradación — que no promete un
 * humano, porque no se creó ningún handoff.
 */
async function handleCircuitOpen(
  conversation: Conversation,
  model: string,
  gate: Extract<CircuitGate, { allow: false }>,
  turnKey?: string
): Promise<void> {
  logAi("warn", {
    event: "circuit_blocked",
    traceId: conversation.id,
    org: conversation.organizationId,
    model,
    code: gate.code,
  });
  if (circuitNoticeRecent(conversation, CIRCUIT.baseCooldownMs)) return;
  try {
    await deliverReply(conversation, aiFallbackMessage(), { turnKey });
    await markCircuitNotice(conversation);
  } catch (err) {
    console.error(
      `[agente] aviso de circuito no enviado: ${describeError(err)}`
    );
  }
}

/**
 * Entrega la respuesta: envío real o persistencia sandbox (is_test).
 *
 * 024 — `turnKey` hace única la respuesta del turno y `offers` son los horarios
 * que el texto muestra: se persisten con el mensaje y se activan cuando Meta lo
 * acepta. Un fallo RECUPERABLE de Meta no lanza: el mensaje queda en el outbox.
 */
async function deliverReply(
  conversation: Conversation,
  text: string,
  ctx: { turnKey?: string; offers?: OfferedSlot[] } = {}
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    // El sandbox nunca sale a Meta: sus horarios son seleccionables al instante.
    if (ctx.offers && ctx.offers.length > 0) {
      await replaceOffers(conversation.organizationId, conversation.id, ctx.offers);
    }
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
      dedupeKey: ctx.turnKey,
      offers: ctx.offers,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    throw err;
  }
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

/**
 * Derivado del enum de la BD: la unión escrita a mano que había aquí omitía
 * `hostilidad` y `manual_reply`, que sí existen en `schema.conversation`.
 */
export type HandoffReason = NonNullable<
  (typeof schema.conversation.$inferSelect)["handoffReason"]
>;

/**
 * Copia FIJA del sistema, nunca del LLM. No es configurable por ahora
 * (decisión del dueño): si algún día lo es, su sitio es `agent_profile`.
 * Mismo patrón que los avisos de reprogramación en `server/agenda/agent.ts`.
 */
const HANDOFF_NOTICE =
  "Voy a pasar tu mensaje con una persona del equipo para darte la respuesta correcta. En un momento te escriben por aquí 🙌";

/**
 * Motivos en los que el cliente DEBE recibir aviso.
 *
 * ALLOWLIST, jamás denylist: un motivo nuevo tiene que caer por defecto en "no
 * avisar". Quedan fuera a propósito:
 *  - `ventana`: con la ventana de 24 h cerrada el agente JAMÁS manda texto
 *    libre (guardrail del canal); el envío rebotaría igual.
 *  - `reprogramacion`: ya manda su propio texto, más específico.
 *  - `manual_reply`: el dueño contestó desde su teléfono — decirle al cliente
 *    "te paso con una persona" justo ahí sería absurdo.
 *  - `hostilidad`: el cliente no debe enterarse de por qué se cortó.
 */
const NOTICE_REASONS = new Set<HandoffReason>(["cliente", "modelo", "error"]);

/**
 * Escala a atención humana Y avisa al cliente.
 *
 * Antes, escalar era SILENCIOSO en todos los motivos automáticos: el prospecto
 * se quedaba esperando una respuesta que no iba a llegar, y el negocio solo se
 * enteraba si alguien miraba la bandeja. Incidente del 2026-09-19.
 *
 * El orden (persistir primero, avisar después) está congelado por
 * `tests/unit/pipeline-handoff-order.test.ts`: un envío que falla nunca puede
 * impedir que el traspaso quede registrado.
 */
async function escalate(
  conversation: Conversation,
  reason: HandoffReason,
  opts?: { farewell?: string | null }
): Promise<void> {
  const aplicado = await applyHandoff(
    conversation.id,
    conversation.organizationId,
    reason
  );
  // Ya estaba escalada: el cliente no debe recibir el aviso dos veces.
  if (!aplicado) return;
  if (!NOTICE_REASONS.has(reason)) return;

  const texto = opts?.farewell?.trim() || HANDOFF_NOTICE;
  try {
    await deliverReply(conversation, texto);
  } catch (err) {
    console.error(
      `[agente] traspaso (${reason}) aplicado pero el aviso no se pudo enviar: ${err}`
    );
  }
}

/** @returns true solo si ESTA llamada aplicó el traspaso (gancho de idempotencia del aviso). */
export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: HandoffReason
): Promise<boolean> {
  const db = getDb();
  // Idempotente a propósito (WHERE handoff_at IS NULL): un segundo intento de
  // traspaso sobre la MISMA conversación (p. ej. la despedida del handoff de
  // arriba falla por ventana cerrada y `deliverReply` dispara su propio
  // applyHandoff("ventana")) no debe pisar el motivo real ya registrado.
  //
  // 026 (regla 11 d/e) — CUALQUIER handoff, sea cual sea el motivo, limpia la
  // memoria de aclaración de disponibilidad: "interviene una persona" cierra
  // el ciclo pendiente, sin importar si la agenda tuvo algo que ver con este
  // traspaso en particular.
  const updated = await db
    .update(schema.conversation)
    .set({
      handoffAt: new Date(),
      handoffReason: reason,
      updatedAt: new Date(),
      agendaClarifyCount: 0,
      agendaClarifyKind: null,
      agendaClarifyContext: null,
    })
    .where(
      and(
        eq(schema.conversation.id, conversationId),
        isNull(schema.conversation.handoffAt)
      )
    )
    .returning();
  if (!updated[0]) return false;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
  return true;
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

