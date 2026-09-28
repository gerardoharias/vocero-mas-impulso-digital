import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-09-16 — Bug reportado sobre una nota de voz de Diego (MÁS Impulso): el
 * turno del agente corría a los 6-8 s del coalesce, mucho antes de que la
 * descarga+transcripción real terminaran, y respondía con el marcador
 * "sin transcripción disponible" aunque el audio fuera perfectamente
 * entendible. Estos tests fijan que:
 * - con transcripción ya lista, el turno la usa sin esperar nada.
 * - con transcripción en curso, el turno ESPERA (awaitMediaJob) antes de
 *   armar el prompt, y usa el resultado fresco si llegó a tiempo.
 * - con transcripción que nunca llega, el turno responde UNA sola vez (con
 *   el marcador), nunca dos mensajes por el mismo audio.
 */

const chatJsonCalls: unknown[][] = [];
const chatJson = vi.fn(async (...args: unknown[]) => {
  chatJsonCalls.push(args);
  return {
    ok: true,
    data: { action: "reply", text: "respuesta simulada" },
    raw: "{}",
  };
});

vi.mock("@/lib/ai", () => ({ chatJson }));

const awaitMediaJob = vi.fn(async () => {});
vi.mock("@/server/whatsapp/media", () => ({ awaitMediaJob }));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: vi.fn() };
});

// BD simulada: cola de resultados de select + capturas de insert.
const selectQueue: unknown[][] = [];
const inserts: { table: unknown; values: unknown }[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: (fields?: Record<string, unknown>) =>
      // Con AGENDA encendida el pipeline también lee los horarios ya ofrecidos
      // (`getOffers`: columnas de `offeredSlot`). Ese select NO forma parte de
      // la cola posicional de abajo: se responde por lo que consulta, con una
      // lista vacía válida (aquí no hay horarios ofrecidos). Si no, se tragaría
      // la fila de otra consulta y el resto de la cola quedaría desfasado.
      fields &&
      Object.values(fields).some(
        (v) => typeof v === "string" && v.startsWith("offeredSlot.")
      )
        ? thenableChain([])
        : thenableChain(selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        const chain = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          const chain = {
            returning: () => Promise.resolve([{}]),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve([{}]).then(resolve),
          };
          return chain;
        },
      }),
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
  id: "cv_lab",
  organizationId: "org_1",
  contactId: "ct_lab",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};

const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: false,
  name: "Max",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: "¡Hola! Soy Max",
};

function audioMessage() {
  return {
    id: "msg_audio",
    direction: "in",
    type: "audio",
    text: null,
    mediaAssetId: "ma_1",
    createdAt: new Date(),
  };
}

function outboundMessages() {
  return inserts.filter(
    (i) =>
      typeof i.values === "object" &&
      i.values !== null &&
      (i.values as { direction?: string }).direction === "out"
  );
}

describe("runAgentTurn — espera de transcripción de audio", () => {
  beforeEach(() => {
    chatJson.mockClear();
    chatJsonCalls.length = 0;
    awaitMediaJob.mockClear();
    selectQueue.length = 0;
    inserts.length = 0;
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("transcripción YA lista → no espera, y el LLM ve el texto real", async () => {
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [audioMessage()],
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: "hola quiero información de precios",
          transcribeError: null,
          fetchStatus: "available",
        },
      ], // fetchAsset "before" en waitForAudioTranscription: ya resuelto
      [], // kb
      [], // stages
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: "hola quiero información de precios",
        },
      ] // media para historyAsChatMessages
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(awaitMediaJob).not.toHaveBeenCalled();
    expect(outboundMessages()).toHaveLength(1);
    const lastCallMessages = chatJsonCalls.at(-1)?.[1] as
      | { role: string; content: string }[]
      | undefined;
    const userTurn = lastCallMessages?.find((m) => m.role === "user");
    expect(userTurn?.content).toBe("hola quiero información de precios");
  });

  it("transcripción en curso y llega a tiempo → espera y usa el texto fresco", async () => {
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [audioMessage()],
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: null,
          transcribeError: null,
          fetchStatus: "pending",
        },
      ], // "before": todavía sin desenlace → dispara la espera
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: "buenas, ¿tienen envíos a Querétaro?",
          transcribeError: null,
          fetchStatus: "available",
        },
      ], // "after" awaitMediaJob: ya transcribió
      [], // kb
      [], // stages
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: "buenas, ¿tienen envíos a Querétaro?",
        },
      ]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(awaitMediaJob).toHaveBeenCalledTimes(1);
    expect(outboundMessages()).toHaveLength(1);
    const lastCallMessages = chatJsonCalls.at(-1)?.[1] as
      | { role: string; content: string }[]
      | undefined;
    const userTurn = lastCallMessages?.find((m) => m.role === "user");
    expect(userTurn?.content).toBe("buenas, ¿tienen envíos a Querétaro?");
  });

  it("transcripción que nunca llega → UN solo mensaje con el marcador, no dos", async () => {
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [audioMessage()],
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: null,
          transcribeError: null,
          fetchStatus: "pending",
        },
      ], // "before"
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: null,
          transcribeError: null,
          fetchStatus: "pending",
        },
      ], // "after": sigue sin desenlace tras el timeout
      [], // kb
      [], // stages
      [{ id: "ma_1", kind: "audio", caption: null }]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(awaitMediaJob).toHaveBeenCalledTimes(1);
    // Un solo turno de LLM → un solo mensaje saliente, jamás saludo + disculpa.
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(outboundMessages()).toHaveLength(1);
    const lastCallMessages = chatJsonCalls.at(-1)?.[1] as
      | { role: string; content: string }[]
      | undefined;
    const userTurn = lastCallMessages?.find((m) => m.role === "user");
    expect(userTurn?.content).toBe("[nota de voz — sin transcripción disponible]");
  });

  it("transcripción con fallo YA registrado → no espera (desenlace ya definitivo)", async () => {
    selectQueue.push(
      [CONVERSATION],
      [PROFILE],
      [audioMessage()],
      [
        {
          id: "ma_1",
          kind: "audio",
          caption: null,
          transcribeError: "sin voz entendible",
          fetchStatus: "available",
        },
      ], // "before": ya falló, es terminal
      [], // kb
      [], // stages
      [{ id: "ma_1", kind: "audio", caption: null }]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(awaitMediaJob).not.toHaveBeenCalled();
    expect(outboundMessages()).toHaveLength(1);
  });
});
