import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estado técnico de fallos por conversación (spec 023 §3.6). Aquí se prueba la
 * forma de las escrituras (con la base simulada); la atomicidad y la ventana de
 * tiempo se verifican contra Postgres real con `scripts/verify-ai-fail-state.ts`.
 */

type Update = { set: Record<string, unknown>; returning?: unknown };
const updates: Update[] = [];
let returningRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    update: () => ({
      set: (set: Record<string, unknown>) => {
        const entry: Update = { set };
        updates.push(entry);
        return {
          where: () => {
            const p = Promise.resolve(returningRows);
            return Object.assign(p, {
              returning: (cols: unknown) => {
                entry.returning = cols;
                return p;
              },
            });
          },
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }
  ),
}));

import {
  CIRCUIT_NOTICE_KIND,
  CONSECUTIVE_FORMAT_FAILURES_LIMIT,
  FAILURE_WINDOW_MS,
  circuitNoticeRecent,
  markCircuitNotice,
  recordFormatFailure,
  resetFailureState,
} from "@/server/ai/failure-state";

const CONV = { id: "cv_1", organizationId: "org_1" };

beforeEach(() => {
  updates.length = 0;
  returningRows = [];
});

describe("recordFormatFailure", () => {
  it("devuelve el conteo que calculó la base (UPDATE … RETURNING), no uno local", async () => {
    returningRows = [{ count: 3 }];
    expect(await recordFormatFailure(CONV, "invalid_schema")).toBe(3);
  });

  it("el incremento lo hace SQL (expresión), no JavaScript: leer-y-escribir tendría carreras", async () => {
    returningRows = [{ count: 1 }];
    await recordFormatFailure(CONV, "invalid_json");
    const { set } = updates[0]!;
    expect(typeof set.aiFailCount).toBe("object"); // objeto sql`` de drizzle, no un número
    expect(set.aiFailKind).toBe("invalid_json");
    expect(set.aiFailAt).toBeInstanceOf(Date);
    expect(updates[0]!.returning).toEqual({ count: "conversation.aiFailCount" });
  });

  it("sin fila devuelta (conversación borrada en carrera) → 1, no lanza", async () => {
    returningRows = [];
    expect(await recordFormatFailure(CONV, "invalid_json")).toBe(1);
  });

  it("el límite de consecutivos es 2 y la ventana 6 h (documentado en la spec)", () => {
    expect(CONSECUTIVE_FORMAT_FAILURES_LIMIT).toBe(2);
    expect(FAILURE_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("resetFailureState / markCircuitNotice", () => {
  it("reset: contador 0 y sin tipo ni fecha", async () => {
    await resetFailureState(CONV);
    expect(updates[0]!.set).toEqual({ aiFailCount: 0, aiFailKind: null, aiFailAt: null });
  });

  it("el aviso de circuito NO toca el contador de fallos de formato", async () => {
    await markCircuitNotice(CONV, new Date("2026-09-20T10:00:00Z"));
    const { set } = updates[0]!;
    expect(set.aiFailKind).toBe(CIRCUIT_NOTICE_KIND);
    expect(set).not.toHaveProperty("aiFailCount");
  });
});

describe("circuitNoticeRecent", () => {
  const now = new Date("2026-09-20T10:00:00Z").getTime();
  it("reciente y del tipo correcto → true", () => {
    expect(
      circuitNoticeRecent({ aiFailKind: "circuit_open", aiFailAt: new Date(now - 60_000) }, 300_000, now)
    ).toBe(true);
  });
  it("vencido, de otro tipo o sin fecha → false", () => {
    expect(
      circuitNoticeRecent({ aiFailKind: "circuit_open", aiFailAt: new Date(now - 400_000) }, 300_000, now)
    ).toBe(false);
    expect(
      circuitNoticeRecent({ aiFailKind: "invalid_json", aiFailAt: new Date(now - 1_000) }, 300_000, now)
    ).toBe(false);
    expect(circuitNoticeRecent({ aiFailKind: "circuit_open", aiFailAt: null }, 300_000, now)).toBe(false);
    expect(circuitNoticeRecent({}, 300_000, now)).toBe(false);
  });
});
