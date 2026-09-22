import { scheduleAgentTurn } from "@/server/ai/pipeline";
import { isAiConfigured } from "@/lib/env";
import type { schema } from "@/lib/db";
import {
  conversationAllowsAgent,
  isAgentEnabledForOrg,
} from "@/server/ai/eligibility";
import { markReadAndTyping } from "@/server/whatsapp/presence";

/**
 * Punto de enganche del turno del agente tras la ingesta de un mensaje
 * entrante REAL (las conversaciones del Laboratorio invocan el pipeline
 * directamente, sin debounce).
 *
 * Aquí vive también la señal de "escribiendo…", y no en la ingesta, porque es
 * una consecuencia de "el agente va a contestar" — la misma decisión que este
 * archivo ya toma. La ingesta no tiene por qué aprender las reglas del agente.
 */
export async function maybeRunAgentTurn(
  conversation: typeof schema.conversation.$inferSelect,
  opts?: { waMessageId?: string | null }
): Promise<void> {
  if (!isAiConfigured()) return;

  // Primero y sin condicionar: el reloj del debounce arranca antes que la
  // llamada de red, y el comportamiento del turno queda exactamente igual que
  // antes de que existiera la señal.
  scheduleAgentTurn(conversation.id);

  // Encender los puntitos SOLO si el agente de verdad va a responder. El
  // prospecto vería el debounce (~6 s) y toda la latencia del modelo en
  // silencio si no; y una señal sin respuesta detrás sería peor que nada.
  if (!conversationAllowsAgent(conversation)) return;
  if (!(await isAgentEnabledForOrg(conversation.organizationId))) return;

  try {
    await markReadAndTyping({
      conversation,
      waMessageId: opts?.waMessageId ?? null,
      // Una ráfaga de mensajes no debe ser una ráfaga de llamadas a Meta.
      minIntervalMs: 10_000,
    });
  } catch (err) {
    // `markReadAndTyping` no lanza; el catch es por si un día alguien mete un
    // throw dentro. Una señal jamás puede tumbar la ingesta.
    console.warn(`[presencia] no pude señalar "escribiendo…": ${err}`);
  }
}
