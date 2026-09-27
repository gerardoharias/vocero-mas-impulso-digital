/**
 * PRUEBA REAL CONTROLADA — spec 025, consultas de disponibilidad, contra
 * OpenRouter con el modelo EXACTO de producción.
 *
 * NO forma parte de `pnpm test` ni del CI. Consume saldo REAL: como máximo 5
 * llamadas facturables (un turno independiente por mensaje, UNA llamada cada
 * uno). Va por el pipeline REAL del agente (prompt real con agenda, `chatJson`
 * real, validación de la acción, motor de disponibilidad real, envío por el
 * outbox) sobre una base Postgres desechable; sólo Meta está simulado.
 *
 * Candados — sin ellos NO se hace ninguna llamada y la prueba se omite:
 *   1. AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO   (a mano, justo antes de correr)
 *   2. AI_LIVE_MODEL=<id exacto>           (el de producción; jamás se hereda OPENROUTER_MODEL)
 *   3. OPENROUTER_API_TOKEN en `.env.live`
 *   4. tope duro en `fetch`: sólo openrouter.ai y NUNCA más de 5 llamadas
 *
 * Uso: ver specs/025-consultas-disponibilidad-calendario/spec.md §11.
 *   pnpm test:ai-live-025
 *
 * ENSAYO SIN COSTO (valida el arnés; jamás toca la red):
 *   AI_LIVE_DRY_RUN=SI     modelo ideal simulado (ai-mock)  → debe pasar
 *   AI_LIVE_DRY_RUN=MALO   modelo que afirma disponibilidad sin consultar → debe FALLAR
 *   AI_LIVE_DRY_RUN=DOBLE  modelo que responde basura la 1ª vez → debe FALLAR (2ª llamada)
 *
 * Jamás se imprime la API key ni texto del modelo o del prospecto: sólo datos
 * operativos (acción, parámetros, modo, llamadas, tokens, horarios).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DRY = (process.env.AI_LIVE_DRY_RUN || "").trim().toUpperCase();
const DRY_MODE = ["SI", "MALO", "DOBLE"].includes(DRY) ? (DRY as "SI" | "MALO" | "DOBLE") : null;
const CONFIRMED = process.env.AI_LIVE_CONFIRM === "SI_CONSUMIR_SALDO";
const HAS_TOKEN = Boolean(process.env.OPENROUTER_API_TOKEN?.trim());
const MODEL = DRY_MODE ? "dry-run-model" : (process.env.AI_LIVE_MODEL || "").trim();
const BASE = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api";
const IS_OPENROUTER = /^https:\/\/([\w-]+\.)?openrouter\.ai(\/|$)/.test(BASE);
const HAS_DB = Boolean(process.env.DATABASE_URL?.trim());
const runnable = HAS_DB && (DRY_MODE !== null || (CONFIRMED && HAS_TOKEN && MODEL !== "" && IS_OPENROUTER));

/** Presupuesto DURO de llamadas facturables. No se sobreescribe por entorno. */
const MAX_CALLS = 5;

if (!runnable) {
  const why = [
    !HAS_DB && "falta DATABASE_URL (servidor Postgres para la base desechable)",
    !CONFIRMED && "falta AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO",
    !HAS_TOKEN && "falta OPENROUTER_API_TOKEN (en .env.live)",
    MODEL === "" && "falta AI_LIVE_MODEL (id exacto del modelo de producción)",
    !IS_OPENROUTER && "OPENROUTER_BASE_URL no es OpenRouter (¿apunta a un mock?)",
  ].filter(Boolean);
  process.stdout.write(`[ai-live-025] OMITIDA — NO se hizo ninguna llamada: ${why.join("; ")}\n`);
}

// --- Espías que registran (sin alterar) lo que pasa por el pipeline real ------------------------
type Shared = {
  queries: { query: Record<string, unknown>; meta: Record<string, unknown> | undefined; status: string; offers: number }[];
  ai: {
    calls: number; mode: string; fellBack: boolean; corrected: boolean; ok: boolean; action: string | null;
    /** Lo que el MODELO devolvió, antes de la normalización y de la compuerta del servidor. */
    raw: { action: string | null; day: unknown; times: unknown; from: unknown; to: unknown; edge: unknown } | null;
  }[];
  engineCalls: number;
  metaSent: { text: string }[];
  agendaOps: { offerSlots: number; bookSlot: number };
};
const shared = ((globalThis as unknown as { __live025?: Shared }).__live025 ??= {
  queries: [],
  ai: [],
  engineCalls: 0,
  metaSent: [],
  agendaOps: { offerSlots: 0, bookSlot: 0 },
});

vi.mock("@/lib/ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai")>();
  return {
    ...original,
    chatJson: async (...args: Parameters<typeof original.chatJson>) => {
      const r = await original.chatJson(...args);
      const s = (globalThis as unknown as { __live025: Shared }).__live025;
      s.ai.push({
        calls: r.meta.calls,
        mode: String(r.meta.mode),
        fellBack: Boolean(r.meta.fellBack),
        corrected: Boolean(r.meta.corrected),
        ok: r.ok,
        // La acción y los campos CRUDOS del modelo (`raw` es el contenido tal cual lo devolvió).
        action: (() => {
          try {
            const j = JSON.parse(String((r as { raw?: string }).raw ?? "")) as { action?: string };
            if (typeof j.action === "string") return j.action;
          } catch {
            /* con vallas de código u otra prosa: se usa la acción ya validada */
          }
          return r.ok ? String((r.data as { action?: string }).action ?? "?") : null;
        })(),
        raw: (() => {
          try {
            const j = JSON.parse(String((r as { raw?: string }).raw ?? "")) as Record<string, unknown>;
            return { action: typeof j.action === "string" ? j.action : null, day: j.day, times: j.times, from: j.from, to: j.to, edge: j.edge };
          } catch {
            return null;
          }
        })(),
      });
      return r;
    },
  };
});

vi.mock("@/server/agenda/agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/agent")>();
  return {
    ...original,
    checkAvailability: async (...args: Parameters<typeof original.checkAvailability>) => {
      const r = await original.checkAvailability(...args);
      (globalThis as unknown as { __live025: Shared }).__live025.queries.push({
        query: { ...(args[0].query as Record<string, unknown>) },
        meta: r.availability as unknown as Record<string, unknown> | undefined,
        status: String(r.status),
        offers: r.offers?.length ?? 0,
      });
      return r;
    },
    offerSlots: (...args: Parameters<typeof original.offerSlots>) => {
      (globalThis as unknown as { __live025: Shared }).__live025.agendaOps.offerSlots++;
      return original.offerSlots(...args);
    },
    bookSlot: (...args: Parameters<typeof original.bookSlot>) => {
      (globalThis as unknown as { __live025: Shared }).__live025.agendaOps.bookSlot++;
      return original.bookSlot(...args);
    },
  };
});

vi.mock("@/server/agenda/availability", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/availability")>();
  return {
    ...original,
    computeAvailability: (...args: Parameters<typeof original.computeAvailability>) => {
      (globalThis as unknown as { __live025: Shared }).__live025.engineCalls++;
      return original.computeAvailability(...args);
    },
  };
});

// Meta simulado: NUNCA se llama a la API real. Registra lo que habría enviado.
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  let seq = 0;
  return {
    ...original,
    graphRequest: async (path: string, opts: { body?: unknown }) => {
      if (path.endsWith("/messages")) {
        const text = (opts.body as { text?: { body?: string } } | undefined)?.text?.body ?? "";
        (globalThis as unknown as { __live025: Shared }).__live025.metaSent.push({ text });
        return { messages: [{ id: `wamid.LIVE025.${++seq}` }] };
      }
      return {};
    },
  };
});

// --- Casos --------------------------------------------------------------------------------------
/** «Ahora» fijo: jueves 17 sep 2026, 12:00 en Ciudad de México (igual que las pruebas de integración). */
const NOW = new Date("2026-09-17T18:00:00Z");
const TODAY = "2026-09-17";
const TOMORROW = "2026-09-18";
const MONDAY = "2026-09-21";

type CaseId = 1 | 2 | 3 | 4 | 5;
const CASES: { id: CaseId; text: string }[] = [
  { id: 1, text: "¿Tienes más horarios mañana?" },
  { id: 2, text: "¿Puedes el lunes a las 11 o 12?" },
  { id: 3, text: "¿Tienes el lunes a las 4 o 5 de la tarde?" },
  { id: 4, text: "¿Cuál es el horario más tarde del lunes?" },
  { id: 5, text: "¿Tienes disponibilidad la semana que viene?" },
];

type Usage = { prompt: number | null; completion: number | null; total: number | null; cost: number | null };
type Report = {
  id: CaseId;
  action: string | null;
  params: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  /** Horarios que el texto MUESTRA al prospecto (`offered_slot.shown`). */
  offeredLocal: string[];
  /** Catálogo registrado (más ancho que lo mostrado) que NO existe en el motor real: debe ser 0. */
  registeredNotReal: number;
  expectedLocal: string[];
  textHasTimes: boolean;
  textNegates: boolean;
  textAsksQuestion: boolean;
  http: number;
  usage: Usage;
  requestedFormat: string | null;
  responseModel: string | null;
  aiMeta: Shared["ai"][number] | null;
  /** Cambios que la compuerta del SERVIDOR tuvo que hacer a la acción del modelo (códigos, sin texto). */
  guard: string[];
  engineCalls: number;
  handoff: boolean;
  bookings: number;
  outboundCount: number;
  agendaOps: { offerSlots: number; bookSlot: number };
};

describe.skipIf(!runnable)("OpenRouter real · consultas de disponibilidad (spec 025)", () => {
  const captured: string[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const http = { calls: 0, hosts: new Set<string>(), log: [] as { turn: number; usage: Usage; format: string | null; model: string | null }[] };
  const realFetch = globalThis.fetch;
  const pendingUsage: Promise<void>[] = [];
  let turnNo = 0;
  const dry = { attempts: new Map<number, number>() };
  const reports: Report[] = [];
  let liveProfile: import("./profile-json").LiveProfile | null = null;
  let testDb: { url: string; drop: () => Promise<void> } | null = null;
  let organizationId = "";
  const PHONE_NUMBER_ID = "PNID_LIVE_025";

  beforeAll(async () => {
    // ANTES de cualquier red, base o llamada: si se pidió un perfil vigente, tiene que ser válido.
    const profilePath = process.env.AI_LIVE_PROFILE_JSON?.trim();
    if (profilePath) {
      const { readFileSync } = await import("node:fs");
      const { validateLiveProfile } = await import("./profile-json");
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(profilePath, "utf8"));
      } catch (err) {
        throw new Error(`[ai-live-025] AI_LIVE_PROFILE_JSON ilegible: ${(err as Error).message.slice(0, 120)}`);
      }
      const check = validateLiveProfile(raw);
      if (!check.ok) {
        throw new Error(
          ["[ai-live-025] AI_LIVE_PROFILE_JSON RECHAZADO (0 llamadas hechas):", ...check.errors.map((e) => ` - ${e}`)].join("\n")
        );
      }
      liveProfile = check.profile;
      for (const w of check.warnings) process.stdout.write(["[ai-live-025] aviso perfil: ", w, "\n"].join(""));
    }
    const fill = (k: string, v: string) => {
      if (!process.env[k]) process.env[k] = v;
    };
    fill("APP_BASE_URL", "http://localhost:3000");
    fill("BETTER_AUTH_SECRET", "live-test-secret-not-used-xx");
    fill("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    fill("META_WEBHOOK_VERIFY_TOKEN", "live-verify-token");
    process.env.AGENDA = "on";
    process.env.AGENT_COALESCE_MS = "0";
    process.env.OUTBOX_POLL_MS = "25";
    process.env.OPENROUTER_MODEL = MODEL;
    if (DRY_MODE) {
      process.env.OPENROUTER_API_TOKEN = "sk-dry-run-not-real";
      process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api";
    }

    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(NOW);

    // Guardia DURA: sólo openrouter.ai, jamás más de MAX_CALLS; en ensayo, NADA sale.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url ?? input);
      const host = new URL(url).hostname;
      if (host !== "openrouter.ai") throw new Error(`[ai-live-025] destino no autorizado: ${host}`);
      if (http.calls >= MAX_CALLS) throw new Error(`[ai-live-025] presupuesto de ${MAX_CALLS} llamadas agotado: no se hace otra`);
      http.calls++;
      http.hosts.add(host);
      let requested: { response_format?: { type?: string }; messages?: { role: string; content: unknown }[] } = {};
      try {
        requested = JSON.parse(String(init?.body ?? "{}"));
      } catch {
        /* cuerpo no JSON */
      }
      const format = requested.response_format?.type ?? null;

      if (DRY_MODE) {
        const { aiMockCompletion } = await import("@/server/dev/ai-mock");
        const n = (dry.attempts.get(turnNo) ?? 0) + 1;
        dry.attempts.set(turnNo, n);
        let content: string;
        if (DRY_MODE === "DOBLE" && n === 1) content = "esto no es JSON";
        else if (DRY_MODE === "MALO") {
          content = JSON.stringify({
            action: "reply",
            text: turnNo === 5 ? "Sí, toda la próxima semana tengo disponibilidad." : "Sí, tengo el lunes a las 4 y a las 5 disponibles.",
          });
        } else content = aiMockCompletion((requested.messages ?? []) as never);
        const body = {
          model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040 },
        };
        http.log.push({ turn: turnNo, usage: { prompt: 2000, completion: 40, total: 2040, cost: null }, format, model: MODEL });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }

      const res = await realFetch(input as RequestInfo, init);
      const clone = res.clone();
      pendingUsage.push(
        clone
          .json()
          .then((j: { usage?: Record<string, unknown>; model?: unknown }) => {
            const u = j.usage ?? {};
            const num = (v: unknown) => (typeof v === "number" ? v : null);
            http.log.push({
              turn: turnNo,
              usage: { prompt: num(u.prompt_tokens), completion: num(u.completion_tokens), total: num(u.total_tokens), cost: num(u.cost) },
              format,
              model: typeof j.model === "string" ? j.model : null,
            });
          })
          .catch(() => {
            http.log.push({ turn: turnNo, usage: { prompt: null, completion: null, total: null, cost: null }, format, model: null });
          })
      );
      return res;
    }) as typeof fetch;

    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          captured.push(args.map(String).join(" "));
        })
      );
    }

    // Base desechable + organización con agente y agenda por defecto (L-V 09:00-18:00).
    const { createTestDatabase } = await import("../integration/helpers/db");
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    const db = getDb();
    organizationId = newId("organization");
    await db.insert(schema.organization).values({ id: organizationId, name: "Org live", slug: `live-${organizationId}` });
    // Configuración EQUIVALENTE A PRODUCCIÓN (no un perfil mínimo): las mismas cinco etapas que
    // siembra el alta (`onUserCreated`) y el perfil real de Max con su base de conocimiento, tal como
    // los deja `seedMasImpulso` (la fuente canónica del repo). El prompt lo arma el pipeline real
    // (`buildAgentSystemPrompt`) con esas filas: nada del prompt se reescribe aquí.
    await db.insert(schema.agentProfile).values({ id: newId("agentProfile"), organizationId });
    const STAGES = [
      ["Nuevo", "open"],
      ["En conversación", "open"],
      ["Interesado", "open"],
      ["Cliente", "won"],
      ["Perdido", "lost"],
    ] as const;
    await db.insert(schema.pipelineStage).values(
      STAGES.map(([name, kind], i) => ({ id: newId("stage"), organizationId, name, position: i, kind }))
    );
    const { seedMasImpulso } = await import("@/server/seed/mas-impulso");
    await seedMasImpulso(db, organizationId);
    // Perfil VIGENTE de producción (export de /api/agent/profile + /api/kb): sustituye por completo a la
    // semilla. Ya viene validado (esquema estricto, sin campos que falten, sin perfil vacío) desde el
    // inicio de este hook; NO se edita ni se recorta nada (la regla heredada «Usa offer_slots» incluida).
    if (liveProfile) {
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.agentProfile)
        .set({
          name: liveProfile.name,
          tone: liveProfile.tone,
          instructions: liveProfile.instructions,
          escalationRules: liveProfile.escalationRules,
          greeting: liveProfile.greeting,
        })
        .where(eq(schema.agentProfile.organizationId, organizationId));
      await db.delete(schema.kbEntry).where(eq(schema.kbEntry.organizationId, organizationId));
      for (const e of liveProfile.kb) {
        await db.insert(schema.kbEntry).values({
          id: newId("kbEntry"),
          organizationId,
          kind: e.kind,
          question: e.kind === "qa" ? e.question : null,
          answer: e.kind === "qa" ? e.answer : null,
          content: e.kind === "block" ? e.content : null,
        });
      }
    }
    {
      // Huella (no el texto) del perfil usado, para compararla con producción.
      const { createHash } = await import("node:crypto");
      const { eq } = await import("drizzle-orm");
      const prof = (await db.select().from(schema.agentProfile).where(eq(schema.agentProfile.organizationId, organizationId)))[0]!;
      const kb = await db.select().from(schema.kbEntry).where(eq(schema.kbEntry.organizationId, organizationId));
      const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);
      process.stdout.write(
        `[ai-live-025] perfil=${liveProfile ? "PRODUCCION(AI_LIVE_PROFILE_JSON)" : "seedMasImpulso(NO es producción)"} nombre="${prof.name}" instruccionesChars=${(prof.instructions ?? "").length} instruccionesSha=${sha(prof.instructions ?? "")} toneSha=${sha(prof.tone ?? "")} reglasEscalamientoSha=${sha(prof.escalationRules ?? "")} kbEntradas=${kb.length} mencionaOfferSlots=${/offer_slots/i.test(prof.instructions ?? "")} etapas=${STAGES.length} agenda=on horario=defecto(L-V 09-18, America/Mexico_City)
`
      );
    }
    await saveCredentials({
      organizationId,
      wabaId: "WABA_LIVE",
      phoneNumberId: PHONE_NUMBER_ID,
      token: "EAAG-TOKEN-DE-PRUEBA-NO-REAL-123456",
      displayPhoneNumber: "5215500000000",
    });
    const { startOutboxWorker } = await import("@/server/outbox");
    startOutboxWorker();
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    spies.forEach((s) => s.mockRestore());
    try {
      const { stopOutboxWorker } = await import("@/server/outbox");
      stopOutboxWorker();
    } catch {
      /* ya detenido */
    }
    try {
      const { getSql } = await import("@/lib/db");
      await getSql().end({ timeout: 2 });
    } catch {
      /* cerrada */
    }
    await testDb?.drop().catch(() => {});
    vi.useRealTimers();
  }, 60_000);

  // --- utilidades ----------------------------------------------------------------------------
  const localParts = (iso: string, tz: string) => {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    const hhmm = new Intl.DateTimeFormat("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    return { day, hhmm, label: `${day} ${hhmm}` };
  };

  async function runTurn(id: CaseId, text: string): Promise<Report> {
    turnNo = id;
    const httpBefore = http.calls;
    const aiBefore = shared.ai.length;
    const logsBefore = captured.length;
    const queriesBefore = shared.queries.length;
    const engineBefore = shared.engineCalls;
    const sentBefore = shared.metaSent.length;
    const opsBefore = { ...shared.agendaOps };
    const from = `52550000010${id}`; // sin el 1 de móviles: `wa_identity` normaliza 521→52

    const { processMessagesValue } = await import("@/server/inbox/ingest");
    await processMessagesValue({
      messaging_product: "whatsapp",
      metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: "5215500000000" },
      contacts: [{ profile: { name: "Prospecto de prueba" }, wa_id: from }],
      messages: [
        {
          from,
          id: `wamid.LIVE025.IN.${id}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "text",
          text: { body: text },
        },
      ],
    } as never);

    const { getDb, schema } = await import("@/lib/db");
    const { eq, and } = await import("drizzle-orm");
    const db = getDb();
    const contact = await (async () => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const r = await db.select().from(schema.contact).where(eq(schema.contact.waIdentity, from));
        if (r[0]) return r[0];
        if (Date.now() > deadline) throw new Error("no se creó el contacto");
        await new Promise((r2) => setTimeout(r2, 50));
      }
    })();
    const conv = (await db.select().from(schema.conversation).where(eq(schema.conversation.contactId, contact.id)))[0]!;

    // Espera a que el turno termine: un saliente entregado (o traspaso), sin nada en vuelo.
    const IN_FLIGHT = new Set(["queued", "sending", "retrying"]);
    const deadline = Date.now() + 100_000;
    for (;;) {
      const out = (await db.select().from(schema.message).where(and(eq(schema.message.conversationId, conv.id), eq(schema.message.direction, "out"))));
      const c = (await db.select().from(schema.conversation).where(eq(schema.conversation.id, conv.id)))[0]!;
      if ((out.length > 0 && !out.some((m) => IN_FLIGHT.has(m.status))) || c.handoffAt) break;
      if (Date.now() > deadline) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    // Margen para que un fallback/segundo mensaje o una 2ª llamada se manifiesten.
    await new Promise((r2) => setTimeout(r2, 2_500));
    await Promise.all(pendingUsage);

    const out = await db.select().from(schema.message).where(and(eq(schema.message.conversationId, conv.id), eq(schema.message.direction, "out")));
    const convNow = (await db.select().from(schema.conversation).where(eq(schema.conversation.id, conv.id)))[0]!;
    const offers = await db.select().from(schema.offeredSlot).where(eq(schema.offeredSlot.conversationId, conv.id));
    const bookings = await db.select({ id: schema.booking.id }).from(schema.booking).where(eq(schema.booking.contactId, contact.id));

    const { getSettings } = await import("@/server/agenda/settings");
    const tz = (await getSettings(organizationId)).timezone;
    const outText = out.map((m) => m.text ?? "").join("\n");
    const q = shared.queries.slice(queriesBefore)[0] ?? null;
    const ai = shared.ai.slice(aiBefore)[0] ?? null;
    const httpRec = http.log.filter((h) => h.turn === id)[0];

    const rep: Report = {
      id,
      action: ai?.action ?? null,
      params: q ? q.query : null,
      meta: q?.meta ?? null,
      offeredLocal: [...new Set(offers.filter((o) => o.shown).map((o) => localParts(o.startUtc.toISOString(), tz).label))].sort(),
      registeredNotReal: 0,
      expectedLocal: [],
      textHasTimes: /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(a\.?\s?m|p\.?\s?m)\b/i.test(outText),
      textNegates: /\bno (hay|tengo|tenemos|queda|quedan|est[aá])\b|ocupad|sin (horarios|disponibilidad)|lleno|agotad|no contamos/i.test(outText),
      textAsksQuestion: /[?¿]/.test(outText),
      http: http.calls - httpBefore,
      usage: httpRec?.usage ?? { prompt: null, completion: null, total: null, cost: null },
      requestedFormat: httpRec?.format ?? null,
      responseModel: httpRec?.model ?? null,
      aiMeta: ai,
      guard: captured
        .slice(logsBefore)
        .filter((l) => l.includes("event=action_guard"))
        .map((l) => l.match(/outcome=(\S+)/)?.[1] ?? "?"),
      engineCalls: shared.engineCalls - engineBefore,
      handoff: Boolean(convNow.handoffAt) || convNow.aiEnabled === false,
      bookings: bookings.length,
      outboundCount: shared.metaSent.length - sentBefore,
      agendaOps: {
        offerSlots: shared.agendaOps.offerSlots - opsBefore.offerSlots,
        bookSlot: shared.agendaOps.bookSlot - opsBefore.bookSlot,
      },
    };
    // Oráculo independiente: lo que el motor REAL dice que hay (se calcula aparte del pipeline).
    const { computeAvailability } = await import("@/server/agenda/availability");
    const real = await computeAvailability(organizationId);
    const byDay = (day: string) => real.filter((s) => localParts(s.startUtc, tz).day === day);
    const at = (day: string, hhmm: string[]) => byDay(day).filter((s) => hhmm.includes(localParts(s.startUtc, tz).hhmm));
    const expected =
      id === 1 ? byDay(TOMORROW)
      : id === 2 ? at(MONDAY, ["11:00", "12:00"])
      : id === 3 ? at(MONDAY, ["16:00", "17:00"])
      : id === 4 ? byDay(MONDAY).slice(-1)
      : [];
    const realLabels = new Set(real.map((s) => localParts(s.startUtc, tz).label));
    rep.registeredNotReal = offers.filter((o) => !realLabels.has(localParts(o.startUtc.toISOString(), tz).label)).length;
    rep.expectedLocal = expected.map((s) => localParts(s.startUtc, tz).label).sort();
    (globalThis as unknown as { __live025expectedTotal?: Record<number, number> }).__live025expectedTotal ??= {};
    (globalThis as unknown as { __live025expectedTotal: Record<number, number> }).__live025expectedTotal[id] = expected.length;
    reports.push(rep);

    process.stdout.write(
      `[ai-live-025] caso=${id} accion=${rep.action} params=${JSON.stringify(rep.params)} http=${rep.http} modo=${rep.aiMeta?.mode} llamadasAdaptador=${rep.aiMeta?.calls} fellBack=${rep.aiMeta?.fellBack} corrected=${rep.aiMeta?.corrected} ` +
        `formatoPedido=${rep.requestedFormat} modeloRespuesta=${rep.responseModel} tokens(in/out/total)=${rep.usage.prompt}/${rep.usage.completion}/${rep.usage.total} costo=${rep.usage.cost} ` +
        `motor=${rep.engineCalls} ofrecidos=${JSON.stringify(rep.offeredLocal)} registradosNoReales=${rep.registeredNotReal} esperados=${JSON.stringify(rep.expectedLocal)} meta=${JSON.stringify(rep.meta)} ` +
        `modeloCrudo=${JSON.stringify(rep.aiMeta?.raw ?? null)} guardServidor=${JSON.stringify(rep.guard)} textoConHoras=${rep.textHasTimes} textoNiega=${rep.textNegates} textoPregunta=${rep.textAsksQuestion} salientes=${rep.outboundCount} handoff=${rep.handoff} citas=${rep.bookings}\n`
    );
    return rep;
  }

  const expectedMode = () => {
    const v = (process.env.AI_RESPONSE_FORMAT || "auto").trim().toLowerCase();
    return v === "json_object" ? "json_object" : v === "off" ? "none" : "json_schema";
  };

  /** Comprobaciones comunes a los cinco turnos: sin fallback, sin escalamiento, sin 2ª llamada de IA. */
  function expectCleanTurn(r: Report) {
    expect(r.http, `caso ${r.id}: llamadas HTTP reales del turno (debe ser exactamente 1)`).toBe(1);
    expect(r.aiMeta?.calls, `caso ${r.id}: llamadas del adaptador`).toBe(1);
    expect(r.aiMeta?.fellBack, `caso ${r.id}: bajó de formato`).toBe(false);
    expect(r.aiMeta?.corrected, `caso ${r.id}: reintento de corrección`).toBe(false);
    expect(r.aiMeta?.ok, `caso ${r.id}: respuesta utilizable`).toBe(true);
    expect(r.aiMeta?.mode, `caso ${r.id}: mecanismo de formato`).toBe(expectedMode());
    expect(r.handoff, `caso ${r.id}: escalamiento a humano`).toBe(false);
    expect(r.bookings, `caso ${r.id}: no se debe agendar nada`).toBe(0);
    expect(r.agendaOps.bookSlot, `caso ${r.id}: book_slot`).toBe(0);
    expect(r.outboundCount, `caso ${r.id}: exactamente UN mensaje al prospecto`).toBe(1);
  }

  /** Las cuatro consultas soportadas: acción, parámetros y resultado contra el motor real. */
  async function expectSupported(r: Report, opts: { needTimes?: number; edge?: "latest" }) {
    expectCleanTurn(r);
    expect(r.action, `caso ${r.id}: acción elegida`).toBe("check_availability");
    expect(r.agendaOps.offerSlots, `caso ${r.id}: no debe caer en offer_slots`).toBe(0);
    expect(r.engineCalls, `caso ${r.id}: el motor se consulta UNA vez`).toBe(1);
    const p = (r.params ?? {}) as { day?: string; times?: string[]; from?: string; to?: string; edge?: string };
    expect(typeof p.day, `caso ${r.id}: falta \`day\``).toBe("string");
    const { resolveDayExpression } = await import("@/lib/time/day-expressions");
    const wantDay = r.id === 1 ? TOMORROW : MONDAY;
    const resolved = resolveDayExpression(String(p.day), TODAY);
    expect(resolved.ok && resolved.dayIso, `caso ${r.id}: «${p.day}» debe resolverse al día correcto`).toBe(wantDay);
    if (opts.needTimes) expect(p.times?.length ?? 0, `caso ${r.id}: \`times\``).toBe(opts.needTimes);
    else expect(p.times ?? [], `caso ${r.id}: no debía pasar \`times\``).toEqual([]);
    if (opts.edge) expect(p.edge, `caso ${r.id}: \`edge\``).toBe(opts.edge);
    else expect(p.edge, `caso ${r.id}: no debía pasar \`edge\``).toBeUndefined();
    // Nada de rangos donde no los hay.
    expect(p.from ?? null, `caso ${r.id}: \`from\``).toBeNull();
    expect(p.to ?? null, `caso ${r.id}: \`to\``).toBeNull();

    // Coincide con el motor real (oráculo independiente) y no inventa ocupación.
    const exp = (globalThis as unknown as { __live025expectedTotal: Record<number, number> }).__live025expectedTotal[r.id]!;
    expect(exp, `caso ${r.id}: el oráculo debe tener horarios (agenda vacía L-V 09-18)`).toBeGreaterThan(0);
    for (const o of r.offeredLocal) {
      expect(r.expectedLocal.includes(o), `caso ${r.id}: se ofreció ${o}, que el motor no reporta libre en lo pedido`).toBe(true);
    }
    if (r.id !== 1) {
      expect(r.offeredLocal, `caso ${r.id}: los horarios ofrecidos deben ser EXACTAMENTE los libres pedidos`).toEqual(r.expectedLocal);
    } else {
      expect(r.offeredLocal.length, "caso 1: debe ofrecer horarios de mañana").toBeGreaterThan(0);
    }
    expect(r.registeredNotReal, `caso ${r.id}: horarios registrados que el motor real no tiene libres`).toBe(0);
    expect((r.meta as { scopeComplete?: boolean } | null)?.scopeComplete, `caso ${r.id}: alcance completo`).toBe(true);
    expect(r.textNegates, `caso ${r.id}: el texto NIEGA disponibilidad y el motor dice que hay`).toBe(false);
  }

  it("1) «¿Tienes más horarios mañana?»", async () => {
    const r = await runTurn(1, CASES[0]!.text);
    await expectSupported(r, {});
  }, 150_000);

  it("2) «¿Puedes el lunes a las 11 o 12?»", async () => {
    const r = await runTurn(2, CASES[1]!.text);
    await expectSupported(r, { needTimes: 2 });
  }, 150_000);

  it("3) «¿Tienes el lunes a las 4 o 5 de la tarde?»", async () => {
    const r = await runTurn(3, CASES[2]!.text);
    await expectSupported(r, { needTimes: 2 });
  }, 150_000);

  it("4) «¿Cuál es el horario más tarde del lunes?»", async () => {
    const r = await runTurn(4, CASES[3]!.text);
    await expectSupported(r, { edge: "latest" });
  }, 150_000);

  it("5) «¿Tienes disponibilidad la semana que viene?»: pide aclaración, no afirma disponibilidad", async () => {
    const r = await runTurn(5, CASES[4]!.text);
    expectCleanTurn(r);
    // La ELECCIÓN del modelo (antes de la compuerta del servidor): la regla heredada «Usa offer_slots» del perfil
    // no puede ganarle a las reglas de la agenda, y la expresión viaja con las palabras del cliente.
    expect(r.action, "caso 5: el MODELO debe elegir check_availability, no offer_slots").toBe("check_availability");
    expect(String(r.aiMeta?.raw?.day ?? ""), "caso 5: `day` conserva el texto original").toMatch(/semana/i);
    expect(r.offeredLocal, "caso 5: no debe ofrecer horarios").toEqual([]);
    expect(r.meta === null || (r.meta as { total?: number }).total === 0, "caso 5: sin horarios registrados").toBe(true);
    expect(r.agendaOps.offerSlots, "caso 5: no debe caer en offer_slots").toBe(0);
    expect(r.textHasTimes, "caso 5: el texto no debe traer horas").toBe(false);
    expect(r.textNegates, "caso 5: no debe negar disponibilidad").toBe(false);
    expect(r.textAsksQuestion, "caso 5: debe pedir aclaración (pregunta)").toBe(true);
    if (r.action === "check_availability") {
      expect((r.meta as { kind?: string } | null)?.kind, "caso 5: la aclaración la genera el servidor").toBe("clarify");
    }
  }, 150_000);

  it("6) presupuesto, tokens y logs: ≤ 5 llamadas, sin API key ni texto del prospecto en logs", () => {
    const tot = http.log.reduce(
      (a, h) => ({
        prompt: a.prompt + (h.usage.prompt ?? 0),
        completion: a.completion + (h.usage.completion ?? 0),
        total: a.total + (h.usage.total ?? 0),
        cost: a.cost + (h.usage.cost ?? 0),
      }),
      { prompt: 0, completion: 0, total: 0, cost: 0 }
    );
    process.stdout.write(
      `[ai-live-025] TOTAL llamadasHTTP=${http.calls}/${MAX_CALLS} hosts=${[...http.hosts].join(",")} tokensEntrada=${tot.prompt} tokensSalida=${tot.completion} tokensTotal=${tot.total} costoReportadoUSD=${tot.cost || "n/d"} modo=${DRY_MODE ? `ENSAYO-${DRY_MODE}` : "REAL"} modelo=${MODEL}\n`
    );
    expect(http.calls, "llamadas HTTP reales en total").toBeLessThanOrEqual(MAX_CALLS);
    expect([...http.hosts].every((h) => h === "openrouter.ai")).toBe(true);
    const logs = captured.join("\n");
    const token = process.env.OPENROUTER_API_TOKEN!.trim();
    // Booleanos a propósito: un fallo de `toContain` imprimiría el texto (con la key, si se filtrara).
    expect(logs.includes(token), "la API key NO debe aparecer en los logs").toBe(false);
    expect(logs.includes("Bearer"), "ningún header de autorización en los logs").toBe(false);
    for (const c of CASES) {
      expect(logs.includes(c.text), `el mensaje del caso ${c.id} no debe estar en los logs`).toBe(false);
    }
    expect(shared.metaSent.length, "sólo se registró (no se envió) lo de Meta simulado").toBe(reports.length);
  });
});
