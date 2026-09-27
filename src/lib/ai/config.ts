/**
 * De dónde sale el modelo EFECTIVO de cada llamada (spec 023 §3.8). Fuente
 * única: `chatJson` y el diagnóstico de Ajustes → IA leen de aquí, así lo que
 * se muestra es lo que se usa.
 *
 * Lectura viva de `process.env` (no `getEnv()`): no exige que todo el entorno
 * valide y nunca toca un token.
 *
 * Precedencia:
 * - Agente:  modelo de la organización (Ajustes → IA)  >  OPENROUTER_MODEL.
 * - Juez:    juez de la organización  >  modelo de la organización  >
 *            OPENROUTER_JUDGE_MODEL  >  OPENROUTER_MODEL.
 * - Transcripción: OPENROUTER_TRANSCRIBE_MODEL  >  OPENROUTER_MODEL. Usa SÓLO
 *   el token/modelo del ENTORNO: la configuración por organización no aplica.
 * No hay modelo por defecto en el código: sin ninguno, `not_configured`.
 */

function envModel(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export type ModelSource = "organization" | "environment";

/** Modelo con el que `chatJson` llamará al proveedor, o null si no hay ninguno. */
export function resolveEffectiveModel(opts?: {
  /** `aiConfig.model` de la organización, o un modelo explícito del llamador. */
  model?: string;
  judge?: boolean;
}): string | null {
  const explicit = opts?.model?.trim();
  if (explicit) return explicit;
  const fromEnv = opts?.judge
    ? (envModel("OPENROUTER_JUDGE_MODEL") ?? envModel("OPENROUTER_MODEL"))
    : envModel("OPENROUTER_MODEL");
  return fromEnv ?? null;
}

export type EffectiveAiModels = {
  agent: { model: string | null; source: ModelSource | null };
  judge: { model: string | null; source: ModelSource | null };
  transcribe: { model: string | null; source: "environment" | null };
};

/** Lo que se usaría hoy, sin llamar a nadie. `org` = la fila de Ajustes → IA, si existe. */
export function effectiveAiModels(
  org: { model: string; judgeModel: string | null } | null
): EffectiveAiModels {
  const pick = (
    orgModel: string | null | undefined,
    envValue: string | null
  ): { model: string | null; source: ModelSource | null } =>
    orgModel
      ? { model: orgModel, source: "organization" }
      : envValue
        ? { model: envValue, source: "environment" }
        : { model: null, source: null };
  const transcribe =
    envModel("OPENROUTER_TRANSCRIBE_MODEL") ?? envModel("OPENROUTER_MODEL") ?? null;
  return {
    agent: pick(org?.model, resolveEffectiveModel()),
    judge: pick(
      org ? (org.judgeModel ?? org.model) : null,
      resolveEffectiveModel({ judge: true })
    ),
    transcribe: { model: transcribe, source: transcribe ? "environment" : null },
  };
}
