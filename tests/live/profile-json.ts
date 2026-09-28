import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Perfil vigente del agente para las pruebas reales (`AI_LIVE_PROFILE_JSON`).
 *
 * Es la MISMA información que lee el pipeline en producción para armar el
 * prompt de sistema: los campos de `GET /api/agent/profile` (`name`, `tone`,
 * `instructions`, `escalationRules`, `greeting`) más las entradas de
 * `GET /api/kb` (`kb`, en el orden en que las lista la API: `createdAt` asc).
 *
 * El esquema es ESTRICTO a propósito:
 *   - toda clave es obligatoria (un campo que falta es un error, no un «sin
 *     cambios»); los textos opcionales pueden ser `null`, pero deben estar;
 *   - ninguna clave extra (así no viajan `id`, `organizationId`, fechas, ni nada
 *     que no sea del perfil);
 *   - un perfil vacío (sin instrucciones o sin base de conocimiento) se rechaza:
 *     probar con él no diría nada sobre producción.
 *
 * Los límites son los de `PUT /api/agent/profile` y `POST /api/kb`.
 */

const KbEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("qa"),
      question: z.string().trim().min(1).max(500),
      answer: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      content: z.string().trim().min(1).max(8000),
    })
    .strict(),
]);

export const LiveProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    tone: z.string().max(500).nullable(),
    instructions: z.string().max(8000),
    escalationRules: z.string().max(4000).nullable(),
    greeting: z.string().max(1000).nullable(),
    kb: z.array(KbEntrySchema),
  })
  .strict();

export type LiveProfile = z.infer<typeof LiveProfileSchema>;

/**
 * Huella (sha256, 12 hex) de las instrucciones de `seedMasImpulso`. Sirve para
 * rechazar un JSON que en realidad es la semilla y no lo vigente en producción.
 * Si cambias la semilla, actualiza este valor (la salida del arnés la imprime
 * como `instruccionesSha`).
 */
export const SEED_INSTRUCTIONS_SHA12 = "7d581aa21877";

export const sha12 = (t: string): string => createHash("sha256").update(t).digest("hex").slice(0, 12);

/** Formas de credenciales que jamás deben viajar en el perfil (rechazo duro). */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-or-[\w-]{8,}/i, "una API key de OpenRouter (sk-or-…)"],
  [/\bsk-[A-Za-z0-9]{20,}/, "una API key (sk-…)"],
  [/\bEAA[A-Za-z0-9]{20,}/, "un token de Meta (EAA…)"],
  [/\bBearer\s+[\w.~+/-]{8,}/i, "un encabezado Authorization (Bearer …)"],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\./, "un JWT"],
  [/(session_token|better-auth\.|set-cookie|cookie:)/i, "una cookie o token de sesión"],
];

export type ProfileCheck =
  | {
      ok: true;
      profile: LiveProfile;
      info: {
        instructionsChars: number;
        instructionsSha: string;
        kbEntries: number;
        kbChars: number;
        /** La regla heredada «Usa offer_slots» (u otra mención): NO se toca, sólo se informa. */
        mentionsOfferSlots: boolean;
        nullFields: string[];
      };
      warnings: string[];
    }
  | { ok: false; errors: string[] };

/** Valida el JSON ya parseado. Jamás incluye el CONTENIDO del perfil en sus mensajes. */
export function validateLiveProfile(raw: unknown): ProfileCheck {
  const parsed = LiveProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => {
        const at = i.path.length ? i.path.join(".") : "(raíz)";
        if (i.code === "unrecognized_keys") return `${at}: claves no permitidas: ${i.keys.join(", ")}`;
        if (i.code === "invalid_type" && (i as { received?: string }).received === "undefined") {
          return `${at}: falta el campo (obligatorio; usa null si el perfil no lo tiene)`;
        }
        if (i.code === "invalid_type") return `${at}: tipo inválido (${i.message})`;
        return `${at}: ${i.message}`;
      }),
    };
  }
  const profile = parsed.data;
  const errors: string[] = [];

  if (profile.instructions.trim() === "") {
    errors.push("instructions: vacío — un perfil sin instrucciones no representa a producción");
  }
  if (profile.kb.length === 0) {
    errors.push("kb: vacío — la base de conocimiento forma parte del prompt real; exporta /api/kb completo");
  }
  if (sha12(profile.instructions) === SEED_INSTRUCTIONS_SHA12) {
    errors.push(
      "instructions: son idénticas a las de la semilla (seedMasImpulso), no a las vigentes en producción — ¿exportaste el perfil correcto?"
    );
  }
  const all = [
    profile.name,
    profile.tone ?? "",
    profile.instructions,
    profile.escalationRules ?? "",
    profile.greeting ?? "",
    ...profile.kb.map((e) => (e.kind === "qa" ? `${e.question}\n${e.answer}` : e.content)),
  ].join("\n");
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(all)) errors.push(`el perfil contiene ${what}: NO debe viajar en el JSON`);
  }
  if (errors.length) return { ok: false, errors };

  const warnings: string[] = [];
  const digitRuns = all.match(/\b\d{10,15}\b/g) ?? [];
  if (digitRuns.length > 0) {
    warnings.push(
      `${digitRuns.length} secuencia(s) de 10-15 dígitos (¿teléfonos o identificadores de WhatsApp?): revisa que sean datos públicos del negocio`
    );
  }
  const nullFields = (["tone", "escalationRules", "greeting"] as const).filter((k) => profile[k] === null);
  return {
    ok: true,
    profile,
    info: {
      instructionsChars: profile.instructions.length,
      instructionsSha: sha12(profile.instructions),
      kbEntries: profile.kb.length,
      kbChars: profile.kb.reduce(
        (n, e) => n + (e.kind === "qa" ? e.question.length + e.answer.length : e.content.length),
        0
      ),
      mentionsOfferSlots: /offer_slots/i.test(profile.instructions),
      nullFields,
    },
    warnings,
  };
}

/**
 * Convierte lo que devuelven las dos APIs al formato del JSON. Sólo copia los
 * campos permitidos (descarta ids, organización, fechas, `enabled`, `aiConfigured`).
 */
export function fromApiResponses(profileRes: unknown, kbRes: unknown): unknown {
  const p = (profileRes as { profile?: Record<string, unknown> } | null)?.profile ?? {};
  const entries = (kbRes as { entries?: Record<string, unknown>[] } | null)?.entries ?? [];
  return {
    name: p.name,
    tone: p.tone,
    instructions: p.instructions,
    escalationRules: p.escalationRules,
    greeting: p.greeting,
    kb: entries.map((e) =>
      e.kind === "qa"
        ? { kind: "qa", question: e.question, answer: e.answer }
        : { kind: "block", content: e.content }
    ),
  };
}
