import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveAiModels, resolveEffectiveModel } from "@/lib/ai/config";

/**
 * De dónde sale el modelo efectivo (spec 023 §3.8): cada precedencia, sin
 * tocar ningún token y sin asumir un modelo por defecto.
 */
describe("resolveEffectiveModel", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_MODEL", "");
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "");
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sin nada configurado → null (no hay modelo por defecto en el código)", () => {
    expect(resolveEffectiveModel()).toBeNull();
    expect(resolveEffectiveModel({ judge: true })).toBeNull();
  });

  it("agente: OPENROUTER_MODEL del entorno", () => {
    vi.stubEnv("OPENROUTER_MODEL", "  proveedor/modelo-env  ");
    expect(resolveEffectiveModel()).toBe("proveedor/modelo-env");
  });

  it("un modelo explícito (el de la organización) pisa al del entorno", () => {
    vi.stubEnv("OPENROUTER_MODEL", "env");
    expect(resolveEffectiveModel({ model: "org" })).toBe("org");
  });

  it("juez: OPENROUTER_JUDGE_MODEL > OPENROUTER_MODEL", () => {
    vi.stubEnv("OPENROUTER_MODEL", "principal");
    expect(resolveEffectiveModel({ judge: true })).toBe("principal");
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "juez-barato");
    expect(resolveEffectiveModel({ judge: true })).toBe("juez-barato");
    // y el agente NO usa el del juez
    expect(resolveEffectiveModel()).toBe("principal");
  });
});

describe("effectiveAiModels (lo que Ajustes → IA muestra)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_MODEL", "env-principal");
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "env-juez");
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", "env-audio");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sin configuración por organización: todo sale del entorno", () => {
    expect(effectiveAiModels(null)).toEqual({
      agent: { model: "env-principal", source: "environment" },
      judge: { model: "env-juez", source: "environment" },
      transcribe: { model: "env-audio", source: "environment" },
    });
  });

  it("con configuración por organización: agente y juez salen de ella; la transcripción SIGUE en el entorno", () => {
    expect(effectiveAiModels({ model: "org-modelo", judgeModel: "org-juez" })).toEqual({
      agent: { model: "org-modelo", source: "organization" },
      judge: { model: "org-juez", source: "organization" },
      transcribe: { model: "env-audio", source: "environment" },
    });
  });

  it("organización sin juez propio: el juez usa el modelo de la organización (no el del entorno)", () => {
    expect(effectiveAiModels({ model: "org-modelo", judgeModel: null }).judge).toEqual({
      model: "org-modelo",
      source: "organization",
    });
  });

  it("transcripción sin modelo propio cae a OPENROUTER_MODEL", () => {
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", "");
    expect(effectiveAiModels(null).transcribe.model).toBe("env-principal");
  });

  it("sin ningún modelo: todo null y sin fuente", () => {
    vi.stubEnv("OPENROUTER_MODEL", "");
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "");
    vi.stubEnv("OPENROUTER_TRANSCRIBE_MODEL", "");
    expect(effectiveAiModels(null)).toEqual({
      agent: { model: null, source: null },
      judge: { model: null, source: null },
      transcribe: { model: null, source: null },
    });
  });

  it("el resultado NO contiene ninguna credencial", () => {
    vi.stubEnv("OPENROUTER_API_TOKEN", "sk-or-super-secreto");
    const json = JSON.stringify(effectiveAiModels({ model: "m", judgeModel: null }));
    expect(json).not.toContain("sk-or");
    expect(json).not.toContain("token");
  });
});
