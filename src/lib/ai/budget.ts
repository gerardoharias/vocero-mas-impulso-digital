/**
 * Presupuesto de llamadas al proveedor (spec 023 §3.3, invariante I1).
 *
 * UN presupuesto por turno del agente, compartido por TODO lo que llama al
 * proveedor dentro de él: reintentos de transporte, escalera de
 * `response_format`, corrección por formato y recuperación de texto plano.
 * Antes cada capa tenía su propio tope y se multiplicaban (peor caso medido: 6
 * llamadas en un turno).
 */
export const TURN_CALL_BUDGET = 3;

export type CallBudget = {
  readonly max: number;
  /** Llamadas que aún se pueden hacer. Lo decrementa `chatJson` ANTES de cada llamada. */
  remaining: number;
};

export function createCallBudget(max: number = TURN_CALL_BUDGET): CallBudget {
  return { max, remaining: max };
}
