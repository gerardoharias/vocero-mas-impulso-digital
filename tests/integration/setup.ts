import { vi } from "vitest";

/**
 * Fronteras externas simuladas para TODAS las pruebas de integración (se
 * registra por `setupFiles`, así que cada archivo las hereda):
 *
 *  - Meta: `graphRequest` (nada sale a la red; cada llamada queda registrada
 *    con su cuerpo exacto y se puede guionar el resultado de cada intento).
 *  - IA: `chatJson` (cuenta las llamadas facturables).
 *  - Disponibilidad: `computeAvailability` (cuenta las consultas; huecos fijos).
 *  - Contadores por envoltura de `offerSlots`/`bookSlot`/`resolveAiConfig`
 *    para saber cuántas veces corrió la acción y cuántas veces corrió el
 *    pipeline (`resolveAiConfig` se llama una vez por ejecución que llega a la IA).
 *
 * Todo lo demás —ingesta, pipeline, agenda, envío, BD— es el código real.
 */

export type MetaScriptEntry =
  | { ok: true; wamid?: string; /** 200 sin `messages[0].id` (ambiguo). */ noId?: boolean }
  | {
      ok: false;
      status: number;
      code?: number | null;
      subcode?: number | null;
      /** Fase de un fallo de red (`status: 0`): ver `NetworkPhase`. */
      phase?: "connect" | "timeout" | "unknown";
      message?: string;
    };

export type MetaCall = {
  n: number;
  path: string;
  /** Cuerpo exacto que habría viajado a Meta. */
  body: unknown;
  /** Texto del mensaje (`body.text.body`) si es un mensaje de texto. */
  text: string | null;
  /** Resultado que produjo la llamada. */
  outcome: string;
  at: number;
};

export type Harness = {
  meta: {
    script: MetaScriptEntry[];
    calls: MetaCall[];
    wamidSeq: number;
    /** Latencia simulada de cada llamada a Meta (para carreras entre trabajadores). */
    delayMs: number;
  };
  ai: {
    script: unknown[];
    calls: number;
    defaultIntro: string;
  };
  availability: {
    calls: number;
    slots: { startUtc: string; endUtc: string; label: string }[];
    /** true ⇒ `computeAvailability` es el motor REAL (horario, tz, buffers, citas). */
    useReal: boolean;
    /** true ⇒ `computeAvailability` lanza (el motor «cae»). */
    fail: boolean;
  };
  counts: { offerSlots: number; bookSlot: number; pipelineRuns: number };
  reset: () => void;
};

/** 21-24 sep 2026, 09:00 y 10:00 hora de Ciudad de México (UTC-6, sin DST). */
function defaultSlots() {
  const out: Harness["availability"]["slots"] = [];
  for (const day of [21, 22, 23, 24]) {
    for (const hour of [15, 16]) {
      const start = new Date(Date.UTC(2026, 8, day, hour, 0, 0));
      const end = new Date(start.getTime() + 30 * 60_000);
      out.push({
        startUtc: start.toISOString(),
        endUtc: end.toISOString(),
        label: `${day} sep, ${hour - 6}:00`,
      });
    }
  }
  return out;
}

export const INCIDENT_INTRO =
  "¡Perfecto! Te comparto los horarios disponibles para tu llamada inicial sin costo.";

function newHarness(): Harness {
  const h: Harness = {
    meta: { script: [], calls: [], wamidSeq: 0, delayMs: 0 },
    ai: { script: [], calls: 0, defaultIntro: INCIDENT_INTRO },
    availability: { calls: 0, slots: defaultSlots(), useReal: false, fail: false },
    counts: { offerSlots: 0, bookSlot: 0, pipelineRuns: 0 },
    reset() {
      h.meta.script.length = 0;
      h.meta.calls.length = 0;
      h.meta.wamidSeq = 0;
      h.meta.delayMs = 0;
      h.ai.script.length = 0;
      h.ai.calls = 0;
      h.ai.defaultIntro = INCIDENT_INTRO;
      h.availability.calls = 0;
      h.availability.slots = defaultSlots();
      h.availability.useReal = false;
      h.availability.fail = false;
      h.counts.offerSlots = 0;
      h.counts.bookSlot = 0;
      h.counts.pipelineRuns = 0;
    },
  };
  return h;
}

const g = globalThis as unknown as { __harness?: Harness; __fetchGuard?: boolean };
export const harness: Harness = (g.__harness ??= newHarness());

/**
 * Red: NADA sale de la máquina (CI y desarrollo). Los mocks de arriba cubren a
 * Meta y a la IA; esta guardia es la segunda línea: si una prueba futura se
 * equivoca de mock (o un módulo llama a `fetch` directo), falla de inmediato en
 * vez de llegar a graph.facebook.com u openrouter.ai con credenciales reales.
 * Sólo se permite loopback. (La BD usa `pg` por TCP, no `fetch`.)
 */
if (!g.__fetchGuard) {
  g.__fetchGuard = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      /* URL relativa o inválida: se trata como no-loopback */
    }
    if (!LOOPBACK.has(host)) {
      return Promise.reject(
        new Error(`red externa bloqueada en pruebas de integración (${host || "destino inválido"})`)
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

vi.mock("@/lib/ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai")>();
  return {
    ...original,
    chatJson: async () => {
      harness.ai.calls++;
      const scripted = harness.ai.script.shift();
      if (scripted !== undefined) return scripted;
      return {
        ok: true,
        data: { action: "offer_slots", reply: harness.ai.defaultIntro },
        raw: "{}",
      };
    },
  };
});

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...original,
    graphRequest: async (path: string, opts: { body?: unknown }) => {
      const isMessage = path.endsWith("/messages");
      const entry = isMessage ? harness.meta.script.shift() : undefined;
      const body = opts.body;
      const text =
        (body as { text?: { body?: string } } | undefined)?.text?.body ?? null;
      const call: MetaCall = {
        n: harness.meta.calls.length + 1,
        path,
        body,
        text,
        outcome: "ok",
        at: Date.now(),
      };
      if (isMessage) harness.meta.calls.push(call);
      if (isMessage && harness.meta.delayMs > 0) {
        await new Promise((r) => setTimeout(r, harness.meta.delayMs));
      }
      if (entry && !entry.ok) {
        call.outcome = `error:${entry.status}/${entry.code ?? "-"}`;
        throw new original.MetaApiError(entry.message ?? "simulated meta error", {
          status: entry.status,
          code: entry.code ?? null,
          subcode: entry.subcode ?? null,
          network: entry.phase ?? null,
          details: entry.code
            ? { error: { code: entry.code, error_subcode: entry.subcode ?? undefined } }
            : null,
        });
      }
      if (entry && entry.ok && entry.noId) {
        call.outcome = "ok:sin-id";
        return { messages: [] };
      }
      const wamid =
        (entry && entry.ok && entry.wamid) || `wamid.OUT.${++harness.meta.wamidSeq}`;
      call.outcome = `ok:${wamid}`;
      return { messages: [{ id: wamid }] };
    },
  };
});

vi.mock("@/server/agenda/availability", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/availability")>();
  return {
    ...original,
    computeAvailability: async (...args: Parameters<typeof original.computeAvailability>) => {
      harness.availability.calls++;
      if (harness.availability.fail) throw new Error("motor de disponibilidad caído (simulado)");
      if (harness.availability.useReal) return original.computeAvailability(...args);
      return harness.availability.slots;
    },
  };
});

vi.mock("@/server/agenda/agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/agent")>();
  return {
    ...original,
    offerSlots: (...args: Parameters<typeof original.offerSlots>) => {
      harness.counts.offerSlots++;
      return original.offerSlots(...args);
    },
    bookSlot: (...args: Parameters<typeof original.bookSlot>) => {
      harness.counts.bookSlot++;
      return original.bookSlot(...args);
    },
  };
});

vi.mock("@/server/ai/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/ai/credentials")>();
  return {
    ...original,
    resolveAiConfig: (...args: Parameters<typeof original.resolveAiConfig>) => {
      harness.counts.pipelineRuns++;
      return original.resolveAiConfig(...args);
    },
  };
});
