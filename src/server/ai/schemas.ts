import type { z } from "zod";
import { transcriptSchema } from "@/lib/ai";
import { agentActionSchema } from "@/server/ai/actions";
import { recoverySchema } from "@/server/ai/recovery";
import { Verdict } from "@/server/lab/judge";

/**
 * Registro de TODOS los esquemas Zod que se le mandan al proveedor como
 * `response_format` (spec 023 §3.9), por el `schemaName` con que viajan.
 *
 * No lo lee el runtime: existe para que el CI recorra cada uno con el conversor
 * (`zodToStrictJsonSchema`) y una incompatibilidad se descubra al correr las
 * pruebas, no la primera vez que un prospecto escribe. La prueba de contrato
 * (`ai-provider-schemas-contract.test.ts`) además escanea el código y falla si
 * aparece un `schemaName` que no está aquí, o si algo se registra sin usarse.
 *
 * Al agregar una llamada nueva a `chatJson`: regístrala aquí.
 */
export const PROVIDER_SCHEMAS: Record<string, { label: string; schema: z.ZodTypeAny }[]> = {
  accion_agente: [
    { label: "agenda apagada", schema: agentActionSchema(false) },
    { label: "agenda encendida", schema: agentActionSchema(true) },
  ],
  veredicto_juez: [{ label: "veredicto del juez", schema: Verdict }],
  transcripcion: [{ label: "transcripción de audio", schema: transcriptSchema }],
  recuperacion_texto: [{ label: "recuperación de texto plano", schema: recoverySchema }],
};
