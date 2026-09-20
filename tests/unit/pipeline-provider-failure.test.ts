import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-09-19 — Incidente en producción. Un prospecto preguntó algo fuera de
 * tema y el proveedor contestó BIEN, pero en prosa en vez de JSON:
 *
 *   [agente] fallo del proveedor (raw): sin JSON extraíble (raw=Eso no te lo
 *   puedo decir, soy Tobias… ¿Seguimos con tu posible demostración?)
 *
 * El CRM tiró esa respuesta, escaló la conversación y NO le mandó nada al
 * cliente, que se quedó esperando. Este camino —`chatJson` devolviendo
 * `ok:false`— no tenía ni un solo test.
 *
 * Lo que se fija aquí: un hipo de FORMATO no cuesta una respuesta, un fallo
 * REAL del proveedor sí escala pero ya no en silencio, y ninguna de las dos
 * cosas se salta el sandbox del Laboratorio.
 */

type ChatJsonFail = {
  ok: false;
  error: "not_configured" | "provider_error" | "invalid_output";
  detail: string;
  raw?: string;
};

const chatJson = vi.fn<() => Promise<ChatJsonFail>>();
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
const updates: { set: Record<string, unknown> }[] = [];
const inserted: Record<string, unknown>[] = [];
/** Lo que devuelve el UPDATE del traspaso: `[]` simula "ya estaba escalada". */
let updateReturning: unknown[] = [{ id: "cv_1" }];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([values]),
          }),
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ set });
        return {
          where: () => ({
            returning: () => Promise.resolve(updateReturning),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve(updateReturning).then(resolve),
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
  name: "Tobias",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

function inboundMessage(text = "¿cuánto cuesta el servicio?") {
  return {
    id: "msg_1",
    direction: "in",
    type: "text",
    text,
    mediaAssetId: null,
    createdAt: new Date(),
  };
}

/** La prosa literal del incidente. */
const PROSA =
  "Eso no te lo puedo decir, soy Tobias, el asistente de Tobaxis, y solo me enfoco en temas de CRM y automatización comercial 🙂\n\n¿Seguimos con tu posible demostración?";

function queueTurn(conversation = CONVERSATION, text?: string) {
  selectQueue.push(
    [conversation],
    [PROFILE],
    [inboundMessage(text)],
    [], // kb
    [] // etapas
  );
}

function handoffUpdates() {
  return updates.filter((u) => u.set.handoffReason !== undefined);
}

function sentTexts(): string[] {
  return sendText.mock.calls.map(
    (call) => (call[0] as { text: string }).text
  );
}

describe("runAgentTurn — el proveedor no devolvió JSON utilizable", () => {
  beforeEach(() => {
    chatJson.mockReset();
    sendText.mockReset();
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.length = 0;
    updates.length = 0;
    inserted.length = 0;
    updateReturning = [{ id: "cv_1" }];
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("prosa utilizable: se entrega al cliente y la conversación NO se escala", async () => {
    // El incidente, al derecho. Esta respuesta era buena.
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "sin JSON extraíble (raw=…)",
      raw: PROSA,
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(sentTexts()).toEqual([PROSA]);
    expect(handoffUpdates()).toHaveLength(0);
  });

  it("fallo REAL del proveedor: escala Y avisa al cliente", async () => {
    // Sin `raw`: el proveedor nunca llegó a hablar, no hay nada que rescatar.
    chatJson.mockResolvedValue({
      ok: false,
      error: "provider_error",
      detail: "proveedor respondió 500: boom",
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(handoffUpdates()[0]?.set.handoffReason).toBe("error");
    // Lo que ya no pasa: escalar en silencio.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain("una persona del equipo");
  });

  it("un raw que NO es entregable escala con aviso en vez de mandarlo", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "no cumple el esquema",
      raw: '{"action":"accion_inventada"}',
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(handoffUpdates()[0]?.set.handoffReason).toBe("error");
    expect(sentTexts()[0]).toContain("una persona del equipo");
  });

  it("si el rescate no se puede entregar, escala: nunca se queda callado", async () => {
    // El texto pasó el filtro pero el canal lo rechaza (p. ej. no cabe).
    sendText
      .mockRejectedValueOnce(new FakeSendError("meta_error", "no cabe"))
      .mockResolvedValue({ messageId: "wam_2" });
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "sin JSON extraíble",
      raw: PROSA,
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await expect(runAgentTurn("cv_1")).resolves.toBeUndefined();

    expect(handoffUpdates()[0]?.set.handoffReason).toBe("error");
    expect(sentTexts()[1]).toContain("una persona del equipo");
  });

  it("si el aviso tampoco sale, el traspaso YA quedó aplicado y el turno no revienta", async () => {
    sendText.mockRejectedValue(new Error("timeout de red"));
    chatJson.mockResolvedValue({
      ok: false,
      error: "provider_error",
      detail: "timeout",
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await expect(runAgentTurn("cv_1")).resolves.toBeUndefined();

    expect(handoffUpdates()[0]?.set.handoffReason).toBe("error");
    expect(handoffUpdates()[0]?.set.handoffAt).toBeInstanceOf(Date);
  });

  it("si la conversación YA estaba escalada, el cliente no recibe el aviso dos veces", async () => {
    updateReturning = []; // el WHERE handoff_at IS NULL no encontró nada
    chatJson.mockResolvedValue({
      ok: false,
      error: "provider_error",
      detail: "proveedor respondió 500",
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(sendText).not.toHaveBeenCalled();
  });

  it("sin IA configurada no escala ni manda nada (silencio correcto)", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "not_configured",
      detail: "Sin OPENROUTER_API_TOKEN configurado",
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(handoffUpdates()).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("en el Laboratorio el rescate JAMÁS toca la API real (FR-031)", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "sin JSON extraíble",
      raw: PROSA,
    });
    queueTurn({ ...CONVERSATION, isTest: true });

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(sendText).not.toHaveBeenCalled();
    // Se persiste como saliente del sandbox en vez de enviarse.
    expect(inserted.some((row) => row.text === PROSA)).toBe(true);
  });
});

describe("runAgentTurn — el cliente pide un humano", () => {
  beforeEach(() => {
    chatJson.mockReset();
    sendText.mockReset();
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.length = 0;
    updates.length = 0;
    inserted.length = 0;
    updateReturning = [{ id: "cv_1" }];
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("pedir un asesor ya no es silencio: escala Y avisa, sin gastar una llamada al LLM", async () => {
    queueTurn(CONVERSATION, "quiero hablar con un asesor");

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(chatJson).not.toHaveBeenCalled(); // el patrón de respaldo corta antes
    expect(handoffUpdates()[0]?.set.handoffReason).toBe("cliente");
    expect(sentTexts()[0]).toContain("una persona del equipo");
  });
});
