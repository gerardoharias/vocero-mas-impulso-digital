import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { resolveAiConfig } from "@/server/ai/credentials";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { salvageProse } from "@/server/ai/salvage";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  bookSlot,
  offerSlots,
  readAgendaState,
  recordRescheduleRequest,
} from "@/server/agenda/agent";
import { getOffers } from "@/server/agenda/offers";
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
    console.error("[agente] turno falló:", err);
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
  if (conversation.handoffAt || !conversation.aiEnabled) return;

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
  const [offers, agendaState] = agenda
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
      ])
    : [[], undefined];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        offers,
        agendaState,
      }),
    },
    ...(await historyAsChatMessages(history)),
  ];

  const aiConfig = await resolveAiConfig(organizationId);
  const result = await chatJson(agentActionSchema(agenda), messages, aiConfig);
  if (!result.ok) {
    if (result.error === "not_configured") return;

    // Red de rescate: si el proveedor llegó a producir texto utilizable pero
    // sin envolverlo en JSON, se entrega como respuesta en vez de escalar.
    // Un hipo de FORMATO no puede costar una respuesta que el modelo ya dio
    // (incidente del 2026-09-19). Un fallo REAL del proveedor no trae texto
    // que rescatar, así que sigue escalando por el camino de abajo.
    const rescatado = salvageProse(result.raw);
    if (rescatado) {
      console.warn(
        `[agente] el proveedor no devolvió JSON; se rescata su texto (conv ${conversationId}): ${result.detail}`
      );
      try {
        await deliverReply(conversation, rescatado);
        return;
      } catch (err) {
        // El rescate no se pudo entregar: NO nos quedamos callados, se escala.
        console.error(`[agente] el texto rescatado no se pudo entregar: ${err}`);
      }
    }

    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await escalate(conversation, "error");
    return;
  }

  let action: AgentActionType = result.data;

  // 015 — Agenda. Un fallo del motor degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
                confirmation: action.reply,
                reason: action.reason,
                confirmAdditional: action.confirmAdditional,
              });
        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
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
        await deliverReply(conversation, action.reply?.trim() || turn.text);
      } catch (err) {
        console.error(
          `[agente] traspaso por reprogramación aplicado pero el aviso no se pudo enviar: ${err}`
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
        await deliverReply(conversation, action.reply);
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, action.text);
      return;
    case "update_lead": {
      await recordAiNote({
        organizationId,
        contactId: conversation.contactId,
        note: action.note,
        scenario: action.scenario ?? null,
        isTest: conversation.isTest,
        sourceMessageId: lastInbound.id,
      });
      if (action.reply) await deliverReply(conversation, action.reply);
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

/** Entrega la respuesta: envío real o persistencia sandbox (is_test). */
async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
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
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
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

