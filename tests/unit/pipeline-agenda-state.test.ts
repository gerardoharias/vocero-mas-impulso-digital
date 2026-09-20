import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/ai";

/**
 * Incidente 2026-09-19 — el dueño agendó una demo con el agente, canceló la
 * cita desde la pantalla de Citas del CRM, escribió "hola" y el agente
 * respondió: "Te recuerdo que tienes tu demostración agendada para el lunes a
 * las 09:00".
 *
 * No era terquedad del modelo: `pipeline.ts` no consultaba NUNCA la tabla
 * `booking`, así que su única fuente sobre citas era su propio "¡Listo! Te
 * agendé para el lunes a las 09:00", todavía en las últimas 20 filas del
 * historial. Afirmó un hecho que solo existía en su transcripción.
 *
 * Estos tests fijan el cableado: que el estado real llegue al prompt, que el
 * Laboratorio y las citas reales no se mezclen, y que un fallo del lector
 * degrade el turno en vez de tumbarlo.
 */

const chatJson = vi.fn();
vi.mock("@/lib/ai", () => ({ chatJson }));

const readAgendaState = vi.fn();
const offerSlots = vi.fn();
const bookSlot = vi.fn();
const recordRescheduleRequest = vi.fn();
vi.mock("@/server/agenda/agent", () => ({
  readAgendaState,
  offerSlots,
  bookSlot,
  recordRescheduleRequest,
}));
vi.mock("@/server/agenda/offers", () => ({ getOffers: async () => [] }));

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

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([values]) }),
        returning: () => Promise.resolve([values]),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve([values]).then(resolve),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ set });
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "cv_1" }]),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve([{ id: "cv_1" }]).then(resolve),
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

function msg(direction: "in" | "out", text: string, id: string) {
  return {
    id,
    direction,
    type: "text",
    text,
    mediaAssetId: null,
    createdAt: new Date(),
  };
}

/** El historial del incidente: el agente confirmó la cita y el cliente saluda. */
const HISTORIAL_DEL_INCIDENTE = [
  msg("in", "para el lunes a las 9 am", "msg_1"),
  msg(
    "out",
    "¡Listo! 🙌 Te agendé la demostración para el lunes a las 09:00.",
    "msg_2"
  ),
  msg("in", "hola", "msg_3"),
];

function queueTurn(
  conversation = CONVERSATION,
  history = [msg("in", "hola", "msg_1")]
) {
  selectQueue.push(
    [conversation],
    [PROFILE],
    // pipeline ordena desc y hace reverse: el orden aquí da igual para el test
    [...history].reverse(),
    [], // kb
    [] // etapas
  );
}

/** El system prompt REAL que salió hacia el proveedor. */
function systemPrompt(): string {
  const messages = chatJson.mock.calls[0]![1] as ChatMessage[];
  return messages[0]!.content as string;
}

describe("runAgentTurn — el estado real de citas llega al prompt", () => {
  beforeEach(() => {
    chatJson.mockReset();
    chatJson.mockResolvedValue({
      ok: true,
      data: { action: "reply", text: "¡Hola! ¿En qué te ayudo?" },
      raw: "{}",
    });
    readAgendaState.mockReset();
    readAgendaState.mockResolvedValue({ kind: "none" });
    sendText.mockReset();
    sendText.mockResolvedValue({ messageId: "wam_1" });
    selectQueue.length = 0;
    updates.length = 0;
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });

  it("con cita vigente, el modelo la ve en su contexto", async () => {
    readAgendaState.mockResolvedValue({
      kind: "active",
      bookings: [
        { label: "lun 21 sep, 09:00", startUtc: "2026-09-21T15:00:00.000Z" },
      ],
    });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(systemPrompt()).toContain("lun 21 sep, 09:00");
  });

  it("EL INCIDENTE: cita cancelada → el prompt contradice al historial", async () => {
    // El historial todavía dice "Te agendé la demostración para el lunes".
    // Sin el bloque, eso era la única fuente del modelo.
    readAgendaState.mockResolvedValue({ kind: "none" });
    queueTurn(CONVERSATION, HISTORIAL_DEL_INCIDENTE);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    const prompt = systemPrompt();
    expect(prompt).toContain("NO tiene NINGUNA cita vigente");
    expect(prompt).toContain("MANDA sobre cualquier cosa dicha antes");
    // Y la confirmación vieja sigue en el historial, que es justo el punto:
    // el bloque tiene que ganarle a eso.
    const messages = chatJson.mock.calls[0]![1] as ChatMessage[];
    expect(JSON.stringify(messages)).toContain("Te agendé la demostración");
  });

  it("una conversación REAL pide las citas reales, no el sandbox", async () => {
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(readAgendaState).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        contactId: "ct_1",
        isTest: false,
      })
    );
  });

  it("el Laboratorio mira SU sandbox: jamás las citas reales del negocio", async () => {
    queueTurn({ ...CONVERSATION, isTest: true });

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(readAgendaState).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: true })
    );
  });

  it("si no se pudo leer la agenda, el turno sigue y no escala", async () => {
    readAgendaState.mockResolvedValue({ kind: "unknown" });
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(systemPrompt()).toContain("no afirmes NINGUNA cita");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.set.handoffReason !== undefined)).toBe(false);
  });

  it("con la agenda APAGADA no se paga la query ni se gasta el token", async () => {
    vi.stubEnv("AGENDA", "");
    queueTurn();

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1");

    expect(readAgendaState).not.toHaveBeenCalled();
    expect(systemPrompt()).not.toContain("ESTADO DE AGENDA");
  });
});
