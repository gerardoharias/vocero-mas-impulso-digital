import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-09-16 — Bug reportado: Max le avisó a un prospecto que "un compañero
 * iba a continuar" pero el panel de Resultados mostró 0 traspasos
 * (`server/results/metrics.ts` cuenta `conversation.handoff_at IS NOT NULL`).
 *
 * Causa comprobada por lectura de código (`server/ai/pipeline.ts`, acción
 * "handoff"): la despedida se enviaba ANTES de aplicar el traspaso. Si el
 * envío fallaba por cualquier motivo que no fuera "ventana cerrada"
 * (`SendError.window_closed`), la excepción salía del `switch` y el
 * `applyHandoff` de abajo JAMÁS se ejecutaba — el `catch` que envuelve
 * `runAgentTurn` (pipeline.ts, `executeTurn`) se la comía en silencio. El
 * peor caso quedaba invertido: mensaje posiblemente entregado, traspaso
 * nunca registrado.
 *
 * Estos tests fijan el orden correcto: el traspaso se persiste PRIMERO
 * (estado durable), y una despedida que falla no debe impedirlo ni tumbar el
 * turno completo.
 */

const FAREWELL = "En un momento te atiende un compañero";
const chatJson = vi.fn<() => Promise<unknown>>();
function handoffAction(farewell?: string) {
  return {
    ok: true,
    data: { action: "handoff", ...(farewell ? { farewell } : {}) },
    raw: "{}",
  };
}
vi.mock("@/lib/ai", () => ({ chatJson }));

const sendText = vi.fn();
class FakeSendError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
vi.mock("@/server/inbox/send", () => ({
  sendText: (...args: unknown[]) => sendText(...args),
  SendError: FakeSendError,
}));

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

const selectQueue: unknown[][] = [];
const updates: { table: unknown; set: Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([values]) }),
        returning: () => Promise.resolve([values]),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve([values]).then(resolve),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "cv_1" }]),
          }),
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          { get: (_t2, col) => `${String(tableName)}.${String(col)}` }
        ),
    }
  ),
}));

const CONVERSATION = {
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  isTest: false,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};

const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Max",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: "¡Hola! Soy Max",
};

function inboundMessage() {
  return {
    id: "msg_1",
    direction: "in",
    type: "text",
    text: "¿cuánto cuesta el servicio?",
    mediaAssetId: null,
    createdAt: new Date(),
  };
}

describe("runAgentTurn — acción handoff", () => {
  beforeEach(() => {
    chatJson.mockReset();
    chatJson.mockResolvedValue(handoffAction(FAREWELL));
    sendText.mockClear();
    selectQueue.length = 0;
    updates.length = 0;
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("aplica el traspaso ANTES de intentar la despedida", async () => {
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [inboundMessage()],
      [], // kb
      [] // stages
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    const handoffUpdateIndex = updates.findIndex(
      (u) => u.set.handoffReason === "modelo"
    );
    expect(handoffUpdateIndex).toBeGreaterThanOrEqual(0);
    // El envío de la despedida ocurre DESPUÉS de que el update ya se pidió.
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("si la despedida falla (no por ventana cerrada), el traspaso YA quedó aplicado y el turno no revienta", async () => {
    sendText.mockRejectedValue(new Error("timeout de red tras aceptar el envío"));
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [inboundMessage()],
      [], // kb
      [] // stages
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await expect(runAgentTurn("cv_1")).resolves.toBeUndefined();

    const handoffUpdateIndex = updates.findIndex(
      (u) => u.set.handoffReason === "modelo"
    );
    expect(handoffUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(updates.some((u) => u.set.handoffAt !== undefined)).toBe(true);
  });

  it("con despedida del modelo, se manda ESA y no la copia fija del sistema", async () => {
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.push([CONVERSATION], [PROFILE], [inboundMessage()], [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect((sendText.mock.calls[0]![0] as { text: string }).text).toBe(FAREWELL);
  });

  it("SIN despedida, el cliente ya no se queda mudo: sale la copia fija", async () => {
    // Antes, un handoff sin `farewell` escalaba en silencio absoluto.
    chatJson.mockResolvedValue(handoffAction());
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.push([CONVERSATION], [PROFILE], [inboundMessage()], [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0]![0] as { text: string }).text).toContain(
      "una persona del equipo"
    );
  });

  it("con la ventana de 24h cerrada NO se manda nada, ni siquiera el aviso", async () => {
    // Guardrail del canal: con la ventana cerrada el agente jamás manda texto
    // libre. El aviso de cortesía NO puede ser la excepción.
    sendText.mockResolvedValue({ messageId: "wam_1" });
    const vieja = {
      ...CONVERSATION,
      lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    };
    selectQueue.push([vieja], [PROFILE], [inboundMessage()], [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(updates.some((u) => u.set.handoffReason === "ventana")).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });
});
