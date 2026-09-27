import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEED_INSTRUCTIONS_SHA12,
  fromApiResponses,
  sha12,
  validateLiveProfile,
} from "../live/profile-json";

/**
 * El validador de `AI_LIVE_PROFILE_JSON` (prueba real de la spec 025): rechaza
 * campos faltantes, claves de más, perfiles vacíos, la semilla disfrazada de
 * producción y credenciales; y no modifica jamás el texto (la regla heredada
 * «Usa offer_slots» viaja intacta).
 */

const INSTRUCTIONS =
  "Eres Max. Habla claro y breve. Cuando el cliente quiera agendar una llamada, usa offer_slots y ofrece los horarios que el sistema pegue. Nunca inventes precios.";

const valid = () => ({
  name: "Max, asesor de prueba",
  tone: "Cercano y claro",
  instructions: INSTRUCTIONS,
  escalationRules: "Escala si piden hablar con una persona.",
  greeting: "¡Hola! Soy Max.",
  kb: [
    { kind: "block", content: "Ofrecemos páginas web y automatización de WhatsApp." },
    { kind: "qa", question: "¿La llamada tiene costo?", answer: "No, es sin costo." },
  ],
});

const errorsOf = (raw: unknown) => {
  const r = validateLiveProfile(raw);
  return r.ok ? [] : r.errors;
};

describe("validateLiveProfile", () => {
  it("acepta un perfil completo y NO toca el texto (la regla «offer_slots» sigue ahí)", () => {
    const r = validateLiveProfile(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.instructions).toBe(INSTRUCTIONS);
    expect(r.info.mentionsOfferSlots).toBe(true);
    expect(r.info.kbEntries).toBe(2);
    expect(r.info.instructionsSha).toBe(sha12(INSTRUCTIONS));
  });

  it("los textos opcionales pueden ser null, pero la clave tiene que estar", () => {
    const ok = validateLiveProfile({ ...valid(), tone: null, escalationRules: null, greeting: null });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.info.nullFields).toEqual(["tone", "escalationRules", "greeting"]);
  });

  it.each(["name", "tone", "instructions", "escalationRules", "greeting", "kb"] as const)(
    "rechaza si falta el campo «%s»",
    (key) => {
      const raw: Record<string, unknown> = valid();
      delete raw[key];
      const errs = errorsOf(raw);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.join("\n")).toContain(key);
    }
  );

  it("rechaza claves de más (ids, organización, fechas…) en el perfil y en la base de conocimiento", () => {
    expect(errorsOf({ ...valid(), organizationId: "org_x" }).join("\n")).toMatch(/claves no permitidas.*organizationId/);
    const raw = valid();
    raw.kb = [{ kind: "block", content: "x", id: "kb_1", createdAt: "2026-01-01" }] as never;
    expect(errorsOf(raw).join("\n")).toMatch(/kb\.0.*claves no permitidas/);
  });

  it("rechaza un perfil vacío: sin instrucciones o sin base de conocimiento", () => {
    expect(errorsOf({ ...valid(), instructions: "   " }).join("\n")).toMatch(/instructions: vacío/);
    expect(errorsOf({ ...valid(), kb: [] }).join("\n")).toMatch(/kb: vacío/);
    expect(errorsOf({ name: "Max", tone: null, instructions: "", escalationRules: null, greeting: null, kb: [] }).length).toBe(2);
  });

  it("rechaza entradas de conocimiento incompletas o de tipo desconocido", () => {
    expect(errorsOf({ ...valid(), kb: [{ kind: "qa", question: "¿?", answer: "" }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid(), kb: [{ kind: "block" }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid(), kb: [{ kind: "otro", content: "x" }] }).length).toBeGreaterThan(0);
  });

  it("rechaza los textos que exceden los límites de la API real", () => {
    expect(errorsOf({ ...valid(), instructions: "x".repeat(8001) }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid(), name: "n".repeat(61) }).length).toBeGreaterThan(0);
  });

  it("rechaza la SEMILLA presentada como perfil de producción (y la huella coincide con la semilla real)", () => {
    // La huella fija tiene que ser la de `seedMasImpulso` de verdad: se lee del código fuente.
    const src = readFileSync(path.join(process.cwd(), "src/server/seed/mas-impulso.ts"), "utf8");
    const literal = src.match(/instructions:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    expect(literal, "no se encontró el literal de las instrucciones de la semilla").toBeDefined();
    const seedInstructions = JSON.parse(literal!) as string;
    expect(sha12(seedInstructions)).toBe(SEED_INSTRUCTIONS_SHA12);
    expect(errorsOf({ ...valid(), instructions: seedInstructions }).join("\n")).toMatch(/idénticas a las de la semilla/);
  });

  it.each([
    ["una API key de OpenRouter", "usa sk-or-v1-abcdef1234567890 para llamar"],
    ["un token de Meta", "token EAAGm0PX4ZCpsBAKZCabcdefghijklmnop123"],
    ["un encabezado Authorization", "Authorization: Bearer abcdefghijklmnop"],
    ["una cookie o token de sesión", "better-auth.session_token=abc"],
  ])("rechaza si el perfil contiene %s", (_what, text) => {
    const errs = errorsOf({ ...valid(), instructions: `${INSTRUCTIONS} ${text}` });
    expect(errs.join("\n")).toMatch(/NO debe viajar/);
    // y el mensaje de error jamás repite el secreto
    expect(errs.join("\n")).not.toContain(text);
  });

  it("avisa (sin rechazar) de secuencias que parecen teléfonos o ids de WhatsApp", () => {
    const r = validateLiveProfile({ ...valid(), greeting: "Escríbenos al 5215500000000" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join("\n")).toMatch(/10-15 dígitos/);
  });

  it("los mensajes de error nunca incluyen el contenido del perfil", () => {
    const secretish = "TEXTO-CONFIDENCIAL-DEL-NEGOCIO";
    const errs = errorsOf({ ...valid(), instructions: secretish + "x".repeat(9000) });
    expect(errs.join("\n")).not.toContain(secretish);
  });
});

describe("fromApiResponses (lo que exporta el snippet del navegador)", () => {
  it("copia sólo los campos permitidos y produce un JSON válido", () => {
    const profileRes = {
      profile: { ...valid(), enabled: true, extra: "no" },
      aiConfigured: true,
    };
    const kbRes = {
      entries: [
        { id: "kb_1", organizationId: "org_1", kind: "block", question: null, answer: null, content: "Ofrecemos webs.", createdAt: "x", updatedAt: "y" },
        { id: "kb_2", organizationId: "org_1", kind: "qa", question: "¿Costo?", answer: "No.", content: null, createdAt: "x", updatedAt: "y" },
      ],
    };
    const out = fromApiResponses(profileRes, kbRes) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["escalationRules", "greeting", "instructions", "kb", "name", "tone"]);
    expect(out.kb).toEqual([
      { kind: "block", content: "Ofrecemos webs." },
      { kind: "qa", question: "¿Costo?", answer: "No." },
    ]);
    expect(validateLiveProfile(out).ok).toBe(true);
  });
});
