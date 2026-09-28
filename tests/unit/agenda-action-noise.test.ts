import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatJson, resetResponseFormatMemory } from "@/lib/ai";
import { agentActionSchema, normalizeAgentAction } from "@/server/ai/actions";
import { AGENDA_PRIORITY_MARKER, buildAgentSystemPrompt } from "@/server/ai/prompts";

/**
 * Spec 025 (revisión correctiva) — dos regresiones de la prueba real con el perfil
 * de producción:
 *
 *  A. El sobre estricto que exige el proveedor obliga a rellenar TODOS los campos:
 *     un modelo pequeño usa `""`, `[]` y hasta un valor plausible del enum. Eso no
 *     puede costar una llamada correctiva ni cambiar lo que consulta la acción.
 *  B. Un perfil heredado que dice «Usa offer_slots» no puede ganarle a las reglas de
 *     la agenda: el prompt lo declara, y el perfil viaja SIN tocar.
 */

describe("A · sobre estricto ruidoso → ausencia (antes de validar el esquema)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
    vi.stubEnv("AI_RESPONSE_FORMAT", "");
    resetResponseFormatMemory();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const providerResponse = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /** Lo que devuelve un modelo pequeño en modo estricto: TODOS los campos, con basura donde no aplica. */
  const NOISY = JSON.stringify({
    action: "check_availability",
    day: "mañana",
    times: [],
    from: "",
    to: "",
    edge: "",
    reply: null,
    text: null,
    startUtc: null,
  });
  const ask = (withNormalize: boolean) =>
    chatJson(agentActionSchema(true), [{ role: "user", content: "hola" }], {
      schemaName: "accion_agente",
      correct: { invalidJson: false },
      ...(withNormalize ? { normalize: normalizeAgentAction } : {}),
    });

  it("con `normalize`: UNA llamada, sin corrección, y los vacíos son ausencia", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(NOISY));
    vi.stubGlobal("fetch", fetchMock);
    const r = await ask(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.meta.calls).toBe(1);
    expect(r.meta.corrected).toBe(false);
    expect(r.data).toEqual({ action: "check_availability", day: "mañana" });
  });

  it("`edge:\"\"` sin normalizar NO pasa el enum: es la causa de la llamada correctiva que se evita", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(NOISY));
    vi.stubGlobal("fetch", fetchMock);
    const r = await ask(false);
    expect(r.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // reintento correctivo (gasto)
  });

  it("un `edge` válido y explícito sobrevive a la normalización", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerResponse(
        JSON.stringify({ action: "check_availability", day: "lunes", times: [], from: "", to: "", edge: "latest" })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await ask(true);
    expect(r.ok && r.data).toEqual({ action: "check_availability", day: "lunes", edge: "latest" });
  });

  it("las demás acciones pasan exactamente igual", () => {
    for (const raw of [
      { action: "reply", text: "hola" },
      { action: "offer_slots", reply: "Claro" },
      { action: "none" },
    ]) {
      expect(normalizeAgentAction(raw)).toEqual(raw);
    }
  });
});

describe("B · perfil con la regla heredada «Usa offer_slots»", () => {
  /** El fragmento heredado, tal como lo escribiría un dueño en «Instrucciones» (NO se edita ni se sanea). */
  const LEGACY =
    "Cuando el cliente quiera agendar o pregunte por horarios y disponibilidad, Usa offer_slots para mostrarle los horarios y anímalo a elegir uno.";
  const profile = {
    id: "agentprofile_1",
    organizationId: "org_1",
    enabled: true,
    name: "Max",
    tone: "Cercano y claro",
    instructions: `Eres Max, asesor comercial.\n${LEGACY}\nNunca inventes precios.`,
    escalationRules: "Escala si piden hablar con una persona.",
    greeting: "¡Hola!",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
  const kb = [
    { id: "kb_1", organizationId: "org_1", kind: "qa", question: "¿Costo?", answer: "Sin costo", content: null, createdAt: new Date(), updatedAt: new Date() },
  ] as never;
  const build = (agenda: boolean) =>
    buildAgentSystemPrompt({ profile: profile as never, kb, stages: [{ name: "Nuevo" }], agenda });

  it("el perfil viaja INTACTO: la regla heredada sigue en el prompt, palabra por palabra", () => {
    expect(build(true)).toContain(LEGACY);
  });

  it("con agenda, la cláusula de prioridad va DESPUÉS de las instrucciones del negocio y ANTES del conocimiento y del contrato de acciones", () => {
    const p = build(true);
    const legacyAt = p.indexOf(LEGACY);
    const priorityAt = p.indexOf(AGENDA_PRIORITY_MARKER);
    const kbAt = p.indexOf("CONOCIMIENTO DEL NEGOCIO");
    const contractAt = p.indexOf('"action":"check_availability"');
    expect(legacyAt).toBeGreaterThan(-1);
    expect(priorityAt).toBeGreaterThan(legacyAt);
    expect(kbAt).toBeGreaterThan(priorityAt);
    expect(contractAt).toBeGreaterThan(priorityAt);
    // y dice lo que tiene que decir sobre la regla heredada
    const clause = p.slice(priorityAt, kbAt);
    expect(clause).toMatch(/mandan sobre cualquier instrucci[oó]n del negocio/);
    expect(clause).toMatch(/usa offer_slots/i);
    expect(clause).toMatch(/sin ning[uú]n d[ií]a, fecha, hora ni rango/);
    expect(clause).toMatch(/check_availability/);
  });

  it("las reglas duras fijan cuándo va cada acción y cómo se llenan los campos", () => {
    const p = build(true);
    expect(p).toMatch(/check_availability es OBLIGATORIA cuando el cliente pregunta por disponibilidad/);
    expect(p).toMatch(/la semana que viene/);
    expect(p).toMatch(/TAL CUAL en day\/times\/from\/to/);
    expect(p).toMatch(/offer_slots SOLO para una solicitud gen[eé]rica/);
    expect(p).toMatch(/aunque las instrucciones del negocio digan "usa offer_slots"/);
    expect(p).toMatch(/`edge` SOLO si el cliente pide expl[ií]citamente/);
    expect(p).toMatch(/"M[aá]s horarios", "qu[eé] horarios hay" o "disponibilidad ma[nñ]ana" NO llevan edge/);
    expect(p).toMatch(/Jam[aá]s cadenas vac[ií]as \(""\) ni arreglos vac[ií]os \(\[\]\)/);
  });

  it("sin agenda no hay cláusula (ni reglas de agenda): el comportamiento de siempre", () => {
    const p = build(false);
    expect(p).not.toContain(AGENDA_PRIORITY_MARKER);
    expect(p).not.toContain("check_availability");
    expect(p).toContain(LEGACY);
  });
});
