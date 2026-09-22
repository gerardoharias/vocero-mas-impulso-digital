import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Cuándo el agente in-process puede actuar sobre una conversación.
 *
 * Existe para que el turno y la señal de "escribiendo…" compartan UNA sola
 * definición: si divergieran, el prospecto vería los tres puntitos de una
 * conversación que en realidad está en manos de una persona.
 */

/** Ni traspasada a un humano ni con la IA pausada en esa conversación. */
export function conversationAllowsAgent(conversation: {
  handoffAt: Date | null;
  aiEnabled: boolean;
}): boolean {
  return !conversation.handoffAt && conversation.aiEnabled;
}

/**
 * El interruptor GLOBAL del agente (Ajustes → Agente). Sin esta comprobación,
 * una instancia con el agente apagado enseñaría "escribiendo…" y nunca
 * respondería.
 *
 * No se cachea a propósito: el operador apaga el agente justamente cuando
 * quiere efecto inmediato.
 */
export async function isAgentEnabledForOrg(
  organizationId: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ enabled: schema.agentProfile.enabled })
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  return rows[0]?.enabled ?? false;
}
