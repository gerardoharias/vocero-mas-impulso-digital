import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RATE_LIMIT_CODES,
  TRANSIENT_CODES,
  classifyFailure,
  hasAttemptsLeft,
  retryDelayMs,
  type FailureSignal,
} from "@/server/outbox/policy";
import { MetaApiError, networkPhaseOf } from "@/lib/meta/client";

/**
 * Spec 024 §4 — la política decide por CÓDIGO de Meta + ETAPA + señal de red.
 * Jamás por el texto del error ni sólo por el HTTP status.
 */

const sync = (s: Omit<FailureSignal, "stage">): FailureSignal => ({ stage: "sync", ...s });
const asyncF = (s: Omit<FailureSignal, "stage">): FailureSignal => ({ stage: "async", ...s });

describe("clasificación: el código de Meta manda sobre el HTTP status", () => {
  it.each([2, 131016, 133004, 131057])("código %i → transient (reintentable)", (code) => {
    for (const httpStatus of [400, 500, 503]) {
      expect(classifyFailure(sync({ code, httpStatus }))).toEqual({
        class: "transient",
        retryable: true,
        ambiguous: false,
      });
    }
    expect(classifyFailure(asyncF({ code })).class).toBe("transient");
  });

  it.each([4, 80007, 130429, 131056])("código %i → rate_limit (reintentable)", (code) => {
    expect(classifyFailure(sync({ code, httpStatus: 400 }))).toEqual({
      class: "rate_limit",
      retryable: true,
      ambiguous: false,
    });
  });

  it("131047 → ventana cerrada, NO reintentable", () => {
    expect(classifyFailure(sync({ code: 131047, httpStatus: 400 }))).toEqual({
      class: "window_closed",
      retryable: false,
      ambiguous: false,
    });
    expect(classifyFailure(asyncF({ code: 131047 })).class).toBe("window_closed");
  });

  it.each([131026, 131030, 131021])("código %i → destinatario no disponible, NO reintentable", (code) => {
    expect(classifyFailure(sync({ code, httpStatus: 400 })).class).toBe("recipient_unavailable");
    expect(classifyFailure(asyncF({ code })).retryable).toBe(false);
  });

  it("190 o HTTP 401 → auth, NO reintentable", () => {
    expect(classifyFailure(sync({ code: 190, httpStatus: 400 })).class).toBe("auth");
    expect(classifyFailure(sync({ httpStatus: 401 })).class).toBe("auth");
    expect(classifyFailure(sync({ code: 190, httpStatus: 401 })).retryable).toBe(false);
  });

  it.each([131048, 131049, 130472, 131031, 132000, 132015, 368, 131000, 999999])(
    "código %i (política, calidad, plantilla, cuenta o desconocido) → permanent",
    (code) => {
      // Aunque llegue con un 5xx: el código de Meta es una decisión de Meta.
      for (const httpStatus of [400, 500]) {
        expect(classifyFailure(sync({ code, httpStatus }))).toEqual({
          class: "permanent",
          retryable: false,
          ambiguous: false,
        });
      }
    }
  );

  it("el código 1 sólo es pasajero con un 5xx (con 4xx es una petición mal formada)", () => {
    expect(classifyFailure(sync({ code: 1, httpStatus: 500 })).class).toBe("transient");
    expect(classifyFailure(sync({ code: 1, httpStatus: 400 })).class).toBe("permanent");
  });
});

describe("clasificación sin código de Meta: etapa y señal de red", () => {
  it("fallo de red ANTES de conectar → transient (la petición nunca salió)", () => {
    expect(classifyFailure(sync({ httpStatus: 0, network: "connect" })).class).toBe("transient");
  });

  it.each(["timeout", "unknown", null] as const)(
    "sin respuesta y red=%s → ambiguous, NUNCA reintentable",
    (network) => {
      expect(classifyFailure(sync({ httpStatus: 0, network }))).toEqual({
        class: "ambiguous",
        retryable: false,
        ambiguous: true,
      });
    }
  );

  it("HTTP 429 → rate_limit; 503 → transient", () => {
    expect(classifyFailure(sync({ httpStatus: 429 })).class).toBe("rate_limit");
    expect(classifyFailure(sync({ httpStatus: 503 })).class).toBe("transient");
  });

  it.each([500, 502, 504, 599])("HTTP %i sin código de Meta → ambiguous (pudo haberlo aceptado)", (httpStatus) => {
    expect(classifyFailure(sync({ httpStatus }))).toEqual({
      class: "ambiguous",
      retryable: false,
      ambiguous: true,
    });
  });

  it("200 sin id de mensaje → ambiguous", () => {
    expect(classifyFailure(sync({ httpStatus: 200, noMessageId: true })).ambiguous).toBe(true);
  });

  it.each([400, 404, 422])("HTTP %i sin código → permanent", (httpStatus) => {
    expect(classifyFailure(sync({ httpStatus })).class).toBe("permanent");
  });

  it("un failed ASÍNCRONO sin código no da evidencia para reenviar → permanent", () => {
    expect(classifyFailure(asyncF({})).class).toBe("permanent");
    expect(classifyFailure(asyncF({ code: null, httpStatus: null })).retryable).toBe(false);
  });

  it("el TEXTO del error no interviene en la decisión", () => {
    // La señal no tiene campo de texto: es imposible decidir por él. Se fija
    // que dos señales idénticas dan el mismo resultado sin importar el idioma.
    const a = classifyFailure(sync({ code: 131016, httpStatus: 503 }));
    const b = classifyFailure(sync({ code: 131016, httpStatus: 503 }));
    expect(a).toEqual(b);
  });
});

describe("lista de reintentables: conservadora y explícita", () => {
  it("son exactamente estos códigos; ampliarla es una decisión con su caso de prueba", () => {
    expect([...TRANSIENT_CODES].sort((a, b) => a - b)).toEqual([2, 131016, 131057, 133004]);
    expect([...RATE_LIMIT_CODES].sort((a, b) => a - b)).toEqual([4, 130429, 131056, 80007].sort((a, b) => a - b));
  });

  it("los errores de calidad/política/spam NO están en la lista", () => {
    for (const code of [131048, 131049, 130472, 131031, 131000]) {
      expect(TRANSIENT_CODES.has(code) || RATE_LIMIT_CODES.has(code)).toBe(false);
    }
  });
});

describe("reintentos: máximo pequeño y backoff con jitter", () => {
  const saved = {
    base: process.env.OUTBOX_RETRY_BASE_MS,
    cap: process.env.OUTBOX_RETRY_CAP_MS,
  };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.OUTBOX_RETRY_BASE_MS;
    else process.env.OUTBOX_RETRY_BASE_MS = saved.base;
    if (saved.cap === undefined) delete process.env.OUTBOX_RETRY_CAP_MS;
    else process.env.OUTBOX_RETRY_CAP_MS = saved.cap;
  });

  it("3 intentos por ciclo automático (1 inicial + 2 reintentos)", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect([0, 1, 2].map(hasAttemptsLeft)).toEqual([true, true, true]);
    expect(hasAttemptsLeft(3)).toBe(false);
    expect(hasAttemptsLeft(4)).toBe(false);
  });

  it("timeout por intento: 30 s", () => {
    expect(ATTEMPT_TIMEOUT_MS).toBe(30_000);
  });

  it("transitorio: techo 5 s → 20 s; el jitter cae en [½·techo, techo]", () => {
    delete process.env.OUTBOX_RETRY_BASE_MS;
    delete process.env.OUTBOX_RETRY_CAP_MS;
    expect(retryDelayMs("transient", 1, () => 0)).toBe(2_500);
    expect(retryDelayMs("transient", 1, () => 1)).toBe(5_000);
    expect(retryDelayMs("transient", 2, () => 0)).toBe(10_000);
    expect(retryDelayMs("transient", 2, () => 1)).toBe(20_000);
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs("transient", 2);
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(20_000);
    }
  });

  it("límite de frecuencia: techo 30 s → 120 s (6× más lento) y tope de 5 min", () => {
    delete process.env.OUTBOX_RETRY_BASE_MS;
    delete process.env.OUTBOX_RETRY_CAP_MS;
    expect(retryDelayMs("rate_limit", 1, () => 1)).toBe(30_000);
    expect(retryDelayMs("rate_limit", 2, () => 1)).toBe(120_000);
    expect(retryDelayMs("rate_limit", 9, () => 1)).toBe(300_000);
  });

  it("tope del transitorio: 60 s aunque crezca el exponente", () => {
    delete process.env.OUTBOX_RETRY_BASE_MS;
    delete process.env.OUTBOX_RETRY_CAP_MS;
    expect(retryDelayMs("transient", 8, () => 1)).toBe(60_000);
  });

  it("el jitter de dos mensajes no coincide siempre (evita reintentos sincronizados)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(retryDelayMs("transient", 1));
    expect(seen.size).toBeGreaterThan(5);
  });

  it("las variables de escala se respetan y valores inválidos caen al defecto", () => {
    process.env.OUTBOX_RETRY_BASE_MS = "40";
    process.env.OUTBOX_RETRY_CAP_MS = "400";
    expect(retryDelayMs("transient", 1, () => 1)).toBe(40);
    process.env.OUTBOX_RETRY_BASE_MS = "abc";
    delete process.env.OUTBOX_RETRY_CAP_MS;
    expect(retryDelayMs("transient", 1, () => 1)).toBe(5_000);
  });
});

describe("cliente de Meta: fase de un fallo de red", () => {
  it("conexión rechazada / DNS → connect (nunca salió)", () => {
    expect(networkPhaseOf({ cause: { code: "ECONNREFUSED" } })).toBe("connect");
    expect(networkPhaseOf({ cause: { code: "ENOTFOUND" } })).toBe("connect");
    expect(networkPhaseOf({ code: "EAI_AGAIN" })).toBe("connect");
  });

  it("timeout / abort → timeout (pudo llegar)", () => {
    expect(networkPhaseOf({ name: "TimeoutError" })).toBe("timeout");
    expect(networkPhaseOf({ name: "AbortError" })).toBe("timeout");
    expect(networkPhaseOf({ cause: { name: "TimeoutError" } })).toBe("timeout");
  });

  it("reset, socket cerrado o desconocido → unknown (ambiguo)", () => {
    expect(networkPhaseOf({ cause: { code: "ECONNRESET" } })).toBe("unknown");
    expect(networkPhaseOf({ cause: { code: "UND_ERR_SOCKET" } })).toBe("unknown");
    expect(networkPhaseOf(new Error("boom"))).toBe("unknown");
    expect(networkPhaseOf(null)).toBe("unknown");
  });

  it("MetaApiError conserva código, subcódigo y fase sin el cuerpo de Meta", () => {
    const e = new MetaApiError("x", { status: 0, code: 2, subcode: 33, network: "timeout" });
    expect([e.code, e.subcode, e.network]).toEqual([2, 33, "timeout"]);
    expect(new MetaApiError("x", { status: 500 }).network).toBeNull();
  });
});
