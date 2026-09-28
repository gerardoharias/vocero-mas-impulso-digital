import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 023 — el pipeline REAL del agente con el adaptador REAL de IA y sólo
 * `fetch` simulado (el proveedor). Reproduce el incidente: Max contestó bien
 * pero en texto plano; el CRM hacía 3 llamadas, descartaba la respuesta y
 * escalaba a un humano.
 *
 * Lo que se mide es lo observable: cuántas llamadas salen al proveedor, qué se
 * le envía al cliente, si se aplicó un traspaso y si se ejecutó alguna acción
 * con efectos secundarios.
 */

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

const bookSlot = vi.fn();
const offerSlots = vi.fn();
const checkAvailability = vi.fn();
const recordRescheduleRequest = vi.fn();
vi.mock("@/server/agenda/agent", () => ({
  bookSlot: (...a: unknown[]) => bookSlot(...a),
  offerSlots: (...a: unknown[]) => offerSlots(...a),
  checkAvailability: (...a: unknown[]) => checkAvailability(...a),
  recordRescheduleRequest: (...a: unknown[]) => recordRescheduleRequest(...a),
  // Incidentes 2026-09-19 y 20: el estado real de citas y el horario de
  // atención del negocio viajan al prompt en cada turno.
  readAgendaState: async () => ({ kind: "none" }),
  readBusinessHours: async () => undefined,
}));
// La señal de presencia ("escribiendo…") sale antes de llamar al modelo y
// hace su propia lectura: sin este mock descuadra la cola de `select` de este
// arnés. Su comportamiento se prueba en `presence-typing.test.ts`.
vi.mock("@/server/whatsapp/presence", () => ({
  markReadAndTyping: async () => {},
  TYPING_TTL_MS: 25_000,
}));
vi.mock("@/server/agenda/offers", () => ({
  getOffers: async () => [],
  offerDays: () => [],
  replaceOffers: async () => {},
}));

const moveLead = vi.fn();
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: (...a: unknown[]) => moveLead(...a),
}));

const recordAiNote = vi.fn();
vi.mock("@/server/contacts/notes", () => ({
  recordAiNote: (...a: unknown[]) => recordAiNote(...a),
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
/** Simula la columna conversation.ai_fail_count (el incremento real es SQL atómico: se verifica contra Postgres). */
const failState = { count: 0, broken: false };
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([values]) }),
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          where: () => {
            let rows: unknown[] = [{ id: "cv_1" }];
            if (set.aiFailKind !== undefined && typeof set.aiFailCount === "object") {
              // recordFormatFailure: `count + 1` calculado por la base
              if (failState.broken) {
                return { returning: () => Promise.reject(new Error("db caída, tel 5512345678")) };
              }
              failState.count += 1;
              rows = [{ count: failState.count }];
            } else if (set.aiFailCount === 0) {
              failState.count = 0; // resetFailureState
            }
            const result = Promise.resolve(rows);
            return Object.assign(result, { returning: () => result });
          },
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
    }
  ),
}));

const FALLBACK =
  "Disculpa, no pude procesar bien tu mensaje. ¿Podrías escribirlo de nuevo, por favor?";
const PREGUNTA_CLIENTE = "¿Me ayudas con mi tarea de historia sobre los hipopótamos azules?";
const RESPUESTA_INCIDENTE =
  "Solo me enfoco en temas de CRM. Si quieres, seguimos con la demostración.";

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: "cv_1",
    organizationId: "org_1",
    contactId: "ct_1",
    isTest: false,
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    lastInboundAt: new Date(),
    aiFailCount: 0,
    aiFailKind: null,
    aiFailAt: null,
    ...over,
  };
}
const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Max",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};
const inbound = (text = PREGUNTA_CLIENTE, id = "msg_in") => ({
  id,
  direction: "in",
  type: "text",
  text,
  mediaAssetId: null,
  aiGenerated: false,
  createdAt: new Date(),
});
const outbound = (text: string, aiGenerated = true) => ({
  id: "msg_out",
  direction: "out",
  type: "text",
  text,
  mediaAssetId: null,
  aiGenerated,
  createdAt: new Date(),
});

/** Encola las lecturas de BD de un turno. `history` va del más nuevo al más viejo (como lo lee el pipeline). */
function queueTurn(opts: {
  conv?: Record<string, unknown>;
  history?: unknown[];
  stages?: { id: string; name: string }[];
}) {
  selectQueue.push(
    [opts.conv ?? conversation()],
    [PROFILE],
    opts.history ?? [inbound()],
    [], // kb
    opts.stages ?? [] // stages
  );
}

function providerJson(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const isRecoveryCall = (init: { body: string }) =>
  JSON.stringify(JSON.parse(init.body).messages).includes("[VERIFICADOR]");
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
  JSON.parse(fetchMock.mock.calls[i]![1]!.body as string);

/** Proveedor guionado: `agent` responde al turno principal; el verificador copia el borrador (como un modelo obediente) salvo que se indique otra cosa. */
function provider(opts: {
  agent: () => Response | Promise<Response>;
  verifier?: (draft: string) => string;
}) {
  return vi.fn().mockImplementation((_url: string, init: { body: string }) => {
    if (isRecoveryCall(init)) {
      const draft = JSON.parse(init.body).messages[1].content.match(
        /<borrador>\n([\s\S]*)\n<\/borrador>/
      )[1] as string;
      const out = opts.verifier
        ? opts.verifier(draft)
        : JSON.stringify({ action: "reply", text: draft });
      return Promise.resolve(providerJson(out));
    }
    return Promise.resolve(opts.agent());
  });
}

const handoffs = () => updates.filter((u) => u.set.handoffAt !== undefined);
const sentTexts = () => sendText.mock.calls.map((c) => (c[0] as { text: string }).text);

let consoleOutput: string[] = [];

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
  vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  vi.stubEnv("AI_RESPONSE_FORMAT", "");
  vi.stubEnv("AI_FALLBACK_MESSAGE", "");
  vi.stubEnv("AGENDA", "");
  sendText.mockReset().mockResolvedValue({ messageId: "wam_1" });
  bookSlot.mockReset();
  offerSlots.mockReset();
  recordRescheduleRequest.mockReset();
  moveLead.mockReset();
  recordAiNote.mockReset();
  selectQueue.length = 0;
  updates.length = 0;
  inserts.length = 0;
  failState.count = 0;
  failState.broken = false;
  resetCircuitState();
  // la config de IA por organización se cachea en proceso: sin esto el orden
  // de las lecturas de BD de un turno dependería del test anterior
  (globalThis as { __aiCredsCache?: unknown }).__aiCredsCache = undefined;
  consoleOutput = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  resetCircuitState();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const { resetResponseFormatMemory } = await import("@/lib/ai");
  resetResponseFormatMemory();
});

import { resetCircuitState } from "@/server/ai/circuit";

async function runTurn() {
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_1");
}

describe("incidente: pregunta fuera de alcance → respuesta correcta en TEXTO PLANO", () => {
  it("no hace 3 llamadas, no escala, no ejecuta acciones y ENTREGA la respuesta", async () => {
    const fetchMock = provider({ agent: () => providerJson(RESPUESTA_INCIDENTE) });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});

    await runTurn();

    // 1 llamada del turno + 1 verificación compacta. Antes: 3 llamadas.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // se entrega la respuesta útil de Max, tal cual
    expect(sentTexts()).toEqual([RESPUESTA_INCIDENTE]);
    expect(sendText.mock.calls[0]![0]).toMatchObject({
      conversationId: "cv_1",
      aiGenerated: true,
    });
    // sin traspaso (antes: applyHandoff("error"))
    expect(handoffs()).toEqual([]);
    // sin acciones con efectos
    expect(bookSlot).not.toHaveBeenCalled();
    expect(offerSlots).not.toHaveBeenCalled();
    expect(recordRescheduleRequest).not.toHaveBeenCalled();
    expect(moveLead).not.toHaveBeenCalled();
    expect(recordAiNote).not.toHaveBeenCalled();
  });

  it("la 1ª llamada ya pide respuesta estructurada; la verificación va SIN historial ni KB y sólo admite reply|none", async () => {
    const fetchMock = provider({ agent: () => providerJson(RESPUESTA_INCIDENTE) });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();

    const main = bodyOf(fetchMock, 0);
    expect(main.response_format.type).toBe("json_schema");
    expect(main.response_format.json_schema.name).toBe("accion_agente");
    expect(JSON.stringify(main.messages)).toContain(PREGUNTA_CLIENTE);

    const verification = bodyOf(fetchMock, 1);
    expect(JSON.stringify(verification.messages)).not.toContain(PREGUNTA_CLIENTE);
    expect(verification.messages).toHaveLength(2);
    expect(verification.response_format.json_schema.schema.properties.action.enum).toEqual([
      "none",
      "reply",
    ]);
  });

  it("los logs no contienen la pregunta del cliente, la respuesta del modelo ni el token", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson(RESPUESTA_INCIDENTE) }));
    queueTurn({});
    await runTurn();
    const logs = consoleOutput.join("\n");
    expect(logs).not.toContain("hipopótamos");
    expect(logs).not.toContain("Solo me enfoco");
    expect(logs).not.toContain("token-test");
    // pero sí dejan rastro operativo correlacionable
    expect(logs).toContain("traceId=cv_1");
    expect(logs).toContain("recovered=plain_text");
  });

  it("en el Laboratorio (is_test) la respuesta recuperada se persiste en el sandbox, JAMÁS por la API", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson(RESPUESTA_INCIDENTE) }));
    queueTurn({ conv: conversation({ isTest: true }) });
    await runTurn();
    expect(sendText).not.toHaveBeenCalled();
    expect(inserts.map((i) => i.values.text)).toContain(RESPUESTA_INCIDENTE);
  });
});

describe("texto plano que NO es seguro entregar", () => {
  it("afirma haber ejecutado algo (el verificador dice none) → degradación, sin acción, sin handoff", async () => {
    const fetchMock = provider({
      agent: () => providerJson("Listo, ya agendé tu cita para el jueves a las 10."),
      verifier: () => JSON.stringify({ action: "none" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentTexts()).toEqual([FALLBACK]); // nunca "ya agendé"
    expect(handoffs()).toEqual([]);
    expect(bookSlot).not.toHaveBeenCalled();
  });

  it("no pasa el filtro determinista (bloque de código) → sin llamada de verificación", async () => {
    const fetchMock = provider({
      agent: () => providerJson("```sql\nDROP TABLE contact;\n```"),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(handoffs()).toEqual([]);
  });

  it("el verificador reescribe el texto → no se envía lo reescrito", async () => {
    const fetchMock = provider({
      agent: () => providerJson(RESPUESTA_INCIDENTE),
      verifier: () =>
        JSON.stringify({ action: "reply", text: `${RESPUESTA_INCIDENTE} Llama al 5512345678` }),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(sentTexts()).toEqual([FALLBACK]);
  });

  it("JSON de acción embebido en una respuesta larga es texto: no ejecuta handoff", async () => {
    const larga =
      "Te explico cómo funciona el traspaso a una persona en nuestro sistema de atención. ".repeat(6) +
      '{"action":"handoff"}';
    vi.stubGlobal("fetch", provider({ agent: () => providerJson(larga) }));
    queueTurn({});
    await runTurn();
    expect(handoffs()).toEqual([]); // no hubo traspaso 'modelo'
    expect(sentTexts()).toEqual([FALLBACK]); // demasiado largo / con JSON → degradación
  });
});

describe("JSON válido que NO cumple el contrato: no se ejecuta nada", () => {
  it("acción desconocida → 1 corrección (2 llamadas, no 3), luego degradación; sin handoff ni efectos", async () => {
    const fetchMock = provider({
      agent: () => providerJson('{"action":"transferir_dinero","monto":100}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(handoffs()).toEqual([]);
    expect(moveLead).not.toHaveBeenCalled();
    expect(recordAiNote).not.toHaveBeenCalled();
  });

  it("book_slot INCOMPLETO (sin startUtc) → no agenda", async () => {
    vi.stubEnv("AGENDA", "on");
    const fetchMock = provider({
      agent: () => providerJson('{"action":"book_slot","reply":"¡Listo, te confirmo tu cita!"}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();

    expect(bookSlot).not.toHaveBeenCalled();
    expect(offerSlots).not.toHaveBeenCalled();
    // y la promesa falsa del reply jamás llega al cliente
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(handoffs()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("acción de agenda con la agenda APAGADA: el modelo ni puede nombrarla → no se ejecuta", async () => {
    // AGENDA apagada: `book_slot` no está en el esquema → es acción desconocida
    vi.stubGlobal(
      "fetch",
      provider({ agent: () => providerJson('{"action":"book_slot","startUtc":"2026-09-20T15:00:00Z"}') })
    );
    queueTurn({});
    await runTurn();
    expect(bookSlot).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([FALLBACK]);
  });

  it("move_stage con una etapa inexistente → no mueve el pipeline", async () => {
    vi.stubGlobal(
      "fetch",
      provider({ agent: () => providerJson('{"action":"move_stage","stage":"Etapa Inventada"}') })
    );
    queueTurn({ stages: [{ id: "stg_1", name: "Interesado" }] });
    await runTurn();
    expect(moveLead).not.toHaveBeenCalled();
    expect(handoffs()).toEqual([]);
  });

  it("move_stage con etapa válida SÍ mueve (la validación no bloquea lo legítimo)", async () => {
    vi.stubGlobal(
      "fetch",
      provider({ agent: () => providerJson('{"action":"move_stage","stage":"Interesado","reply":"Anotado"}') })
    );
    // `moveLeadToStage` (pipeline) busca primero el lead del contacto
    selectQueue.push(
      [conversation()],
      [PROFILE],
      [inbound()],
      [],
      [{ id: "stg_1", name: "Interesado" }],
      [], // resolveAiConfig
      [{ id: "ld_1" }] // lead
    );
    await runTurn();
    expect(moveLead).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual(["Anotado"]);
  });

  it("estricto: los null que el proveedor rellena en lo que no aplica no rompen una acción válida", async () => {
    const fetchMock = provider({
      agent: () =>
        providerJson(
          '{"action":"reply","text":"¡Hola! ¿En qué te ayudo?","note":null,"scenario":null,"stage":null,"reply":null,"reason":null,"farewell":null}'
        ),
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual(["¡Hola! ¿En qué te ayudo?"]);
  });
});

describe("política de handoff", () => {
  it("un fallo de formato AISLADO no escala ni apaga la IA", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await runTurn();
    expect(handoffs()).toEqual([]);
    expect(sentTexts()).toEqual([FALLBACK]);
  });

  it("el mensaje de degradación no promete un humano", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await runTurn();
    expect(sentTexts()[0]).not.toMatch(/humano|persona|asesor|compañero|equipo/i);
  });

  it("AI_FALLBACK_MESSAGE configura el mensaje", async () => {
    vi.stubEnv("AI_FALLBACK_MESSAGE", "Ups, ¿me lo repites?");
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await runTurn();
    expect(sentTexts()).toEqual(["Ups, ¿me lo repites?"]);
  });

  it("dos fallos de formato CONSECUTIVOS (contador técnico en la base) → handoff 'error', sin más mensajes", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    failState.count = 1; // el turno anterior ya falló y quedó registrado
    queueTurn({ conv: conversation({ aiFailCount: 1, aiFailKind: "invalid_schema", aiFailAt: new Date() }) });
    await runTurn();
    expect(handoffs()).toHaveLength(1);
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("la detección NO depende del texto visible: sin ningún mensaje de degradación en el historial, con contador 1, escala", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    failState.count = 1;
    queueTurn({ history: [inbound("otra vez", "msg_in2"), outbound("Otra cosa distinta"), inbound()] });
    await runTurn();
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
  });

  it("…ni al revés: un historial con el texto EXACTO de la degradación, pero contador 0, NO escala", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({ history: [inbound("otra vez", "msg_in2"), outbound(FALLBACK), inbound()] });
    await runTurn();
    expect(handoffs()).toEqual([]);
    expect(sentTexts()).toEqual([FALLBACK]);
  });

  it("cambiar AI_FALLBACK_MESSAGE entre turnos no rompe la cuenta de consecutivos", async () => {
    vi.stubEnv("AI_FALLBACK_MESSAGE", "Mensaje A");
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await runTurn();
    expect(sentTexts()).toEqual(["Mensaje A"]);
    expect(failState.count).toBe(1);

    vi.stubEnv("AI_FALLBACK_MESSAGE", "Mensaje B, totalmente distinto");
    queueTurn({ conv: conversation({ aiFailCount: 1, aiFailKind: "invalid_schema", aiFailAt: new Date() }) });
    await runTurn();
    expect(handoffs()).toHaveLength(1); // el segundo consecutivo escala aunque el texto haya cambiado
  });

  it("un turno EXITOSO reinicia el contador; el siguiente fallo vuelve a ser aislado", async () => {
    const ok = provider({ agent: () => providerJson('{"action":"reply","text":"Hola"}') });
    vi.stubGlobal("fetch", ok);
    failState.count = 1;
    queueTurn({ conv: conversation({ aiFailCount: 1, aiFailKind: "invalid_schema", aiFailAt: new Date() }) });
    await runTurn();
    expect(failState.count).toBe(0);
    expect(updates.some((u) => u.set.aiFailCount === 0 && u.set.aiFailKind === null)).toBe(true);

    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await runTurn();
    expect(handoffs()).toEqual([]);
    expect(failState.count).toBe(1);
  });

  it("una respuesta de texto plano RECUPERADA también reinicia el contador (el cliente sí recibió respuesta)", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson(RESPUESTA_INCIDENTE) }));
    failState.count = 1;
    queueTurn({ conv: conversation({ aiFailCount: 1, aiFailKind: "invalid_schema", aiFailAt: new Date() }) });
    await runTurn();
    expect(failState.count).toBe(0);
    expect(sentTexts()).toEqual([RESPUESTA_INCIDENTE]);
  });

  it("un turno sano sobre una conversación limpia NO escribe en la base el estado de fallos", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"reply","text":"Hola"}') }));
    queueTurn({});
    await runTurn();
    expect(updates.filter((u) => "aiFailCount" in u.set)).toEqual([]);
  });

  it("si la base no puede registrar el fallo, se degrada (nunca se escala a ciegas) y el error no filtra datos", async () => {
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    failState.broken = true;
    queueTurn({});
    await expect(runTurn()).resolves.toBeUndefined();
    expect(handoffs()).toEqual([]);
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(consoleOutput.join("\n")).not.toContain("5512345678");
  });

  it("si el mensaje de degradación no puede enviarse, el turno no revienta ni escala", async () => {
    sendText.mockRejectedValue(new Error("Meta 500 para 5512345678"));
    vi.stubGlobal("fetch", provider({ agent: () => providerJson('{"action":"???"}') }));
    queueTurn({});
    await expect(runTurn()).resolves.toBeUndefined();
    expect(handoffs()).toEqual([]);
    expect(consoleOutput.join("\n")).not.toContain("5512345678");
  });

  it("fallo persistente del proveedor (500) → handoff 'error' (política de siempre), tras reintentos acotados", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    const turn = runTurn();
    await vi.advanceTimersByTimeAsync(5000);
    await turn;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(handoffs()).toHaveLength(1);
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
    expect(sendText).not.toHaveBeenCalled();
    expect(consoleOutput.join("\n")).not.toContain("boom");
  });

  it("429 persistente → handoff 'error' respetando Retry-After (1 s)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("x", { status: 429, headers: { "retry-after": "1" } }))
    );
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    const turn = runTurn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await turn;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
  });

  it("credencial rechazada (401) → UNA llamada, handoff 'error' (config: reintentar no lo arregla)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
    expect(consoleOutput.join("\n")).toContain("code=unauthorized");
  });

  it("timeout se registra como `timeout`, no como formato inválido, y NO manda el mensaje de degradación", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    const turn = runTurn();
    await vi.advanceTimersByTimeAsync(130_000);
    await turn;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleOutput.join("\n")).toContain("code=timeout");
    expect(sentTexts()).toEqual([]);
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
  });

  it("sin IA configurada el turno es silencioso (como siempre): sin llamadas, sin handoff", async () => {
    vi.stubEnv("OPENROUTER_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handoffs()).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
  });
});

/** Rechazo EXPLÍCITO del proveedor: response_format no soportado. */
const unsupportedFormat = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "response_format json_schema is not supported with this model",
        param: "response_format",
        code: "unsupported_parameter",
      },
    }),
    { status: 400 }
  );

describe("modelo sin soporte de response_format (compatibilidad)", () => {
  it("auto: ante un rechazo EXPLÍCITO baja a json_object con log observable, el turno sale bien y el nivel se recuerda", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? unsupportedFormat()
          : providerJson('{"action":"reply","text":"Hola desde json_object"}')
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();

    expect(sentTexts()).toEqual(["Hola desde json_object"]);
    expect(bodyOf(fetchMock, 1).response_format).toEqual({ type: "json_object" });
    expect(consoleOutput.join("\n")).toContain("event=format_fallback");
    expect(handoffs()).toEqual([]);

    // segundo turno: arranca directo en json_object
    queueTurn({});
    await runTurn();
    expect(bodyOf(fetchMock, 2).response_format).toEqual({ type: "json_object" });
  });

  it("un 400 GENÉRICO no degrada en silencio: invalid_request, UNA llamada, handoff 'error' visible en el log", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "Bad Request" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logs = consoleOutput.join("\n");
    expect(logs).toContain("code=invalid_request");
    expect(logs).not.toContain("format_fallback");
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
  });

  it("valor fijo incompatible → error claro, UNA llamada, handoff 'error' (sin bucles)", async () => {
    vi.stubEnv("AI_RESPONSE_FORMAT", "json_schema");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(unsupportedFormat()));
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({});
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleOutput.join("\n")).toContain("code=unsupported_response_format");
    expect(handoffs()[0]!.set.handoffReason).toBe("error");
  });
});

describe("I1: presupuesto de llamadas por turno (medido sobre TODAS las llamadas al proveedor)", () => {
  // Una respuesta del proveedor por "tipo"; la n-ésima llamada del turno recibe el tipo n de la secuencia.
  const KINDS: Record<string, () => Promise<Response>> = {
    ok: () => Promise.resolve(providerJson('{"action":"reply","text":"hola"}')),
    plain: () =>
      Promise.resolve(providerJson("Solo me enfoco en temas de CRM. Si quieres, seguimos con la demostración.")),
    badschema: () => Promise.resolve(providerJson('{"action":"otra"}')),
    e500: () => Promise.resolve(new Response("x", { status: 500 })),
    e429: () =>
      Promise.resolve(new Response("x", { status: 429, headers: { "retry-after": "1" } })),
    unsupported: () => Promise.resolve(unsupportedFormat()),
    generic400: () => Promise.resolve(new Response("{}", { status: 400 })),
    net: () => Promise.reject(new TypeError("fetch failed")),
  };
  const FORMAT_ONLY = new Set(["ok", "plain", "badschema"]);
  const names = Object.keys(KINDS);

  async function run(seq: string[]) {
    let i = 0;
    const fetchMock = vi.fn().mockImplementation(() => KINDS[seq[Math.min(i++, seq.length - 1)]!]!());
    vi.stubGlobal("fetch", fetchMock);
    selectQueue.length = 0;
    updates.length = 0;
    sendText.mockClear();
    failState.count = 0;
    resetCircuitState();
    (globalThis as { __aiCredsCache?: unknown }).__aiCredsCache = undefined;
    const { resetResponseFormatMemory } = await import("@/lib/ai");
    resetResponseFormatMemory();
    queueTurn({});
    const turn = runTurn();
    await vi.advanceTimersByTimeAsync(200_000);
    await turn;
    return fetchMock.mock.calls.length;
  }

  it("cualquier combinación de 3 respuestas (512 secuencias): ≤ 3 llamadas; sólo formato: ≤ 2, sin handoff y con a lo sumo un mensaje", async () => {
    vi.useFakeTimers();
    let worst = 0;
    let worstFormatOnly = 0;
    let sequences = 0;
    for (const a of names) {
      for (const b of names) {
        for (const c of names) {
          const seq = [a, b, c];
          const calls = await run(seq);
          sequences++;
          worst = Math.max(worst, calls);
          expect(calls, `secuencia ${seq.join(",")}`).toBeLessThanOrEqual(3);
          if (seq.every((k) => FORMAT_ONLY.has(k))) {
            worstFormatOnly = Math.max(worstFormatOnly, calls);
            expect(calls, `sólo formato ${seq.join(",")}`).toBeLessThanOrEqual(2);
            expect(handoffs(), `sólo formato ${seq.join(",")}`).toEqual([]);
          }
          // o se le responde al cliente, o se escala — nunca ambos, nunca dos mensajes
          expect(sendText.mock.calls.length, seq.join(",")).toBeLessThanOrEqual(1);
          expect(handoffs().length > 0 && sendText.mock.calls.length > 0, seq.join(",")).toBe(false);
        }
      }
    }
    expect(sequences).toBe(512);
    // el peor caso ALCANZA el tope (la prueba no es vacua) y el de formato el suyo
    expect(worst).toBe(3);
    expect(worstFormatOnly).toBe(2);
  }, 120_000);

  it("el peor caso histórico (texto plano + dos 500 + un 400) ya no ocurre: termina en 3 llamadas y degrada", async () => {
    vi.useFakeTimers();
    const calls = await run(["plain", "e500", "e500", "generic400"]);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("tres transitorios agotan el presupuesto: NO se abre la recuperación aunque el 3º traiga texto plano", async () => {
    vi.useFakeTimers();
    const calls = await run(["e500", "e500", "plain"]);
    expect(calls).toBe(3); // 1 + 2 reintentos; la recuperación no tiene con qué
    expect(sendText.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual([FALLBACK]);
    expect(handoffs()).toEqual([]);
  });

  it("texto plano al primer intento SÍ deja presupuesto para la recuperación (total 2)", async () => {
    vi.useFakeTimers();
    const calls = await run(["plain", "ok"]); // la 2ª llamada es el verificador; 'ok' no coincide → degrada
    expect(calls).toBe(2);
  });
});

describe("circuito de protección en el pipeline (falla GLOBAL vs. fallo aislado)", () => {
  const convOf = (id: string, over: Record<string, unknown> = {}) => conversation({ id, ...over });
  const unauthorized = () => vi.fn().mockImplementation(() => Promise.resolve(new Response("no", { status: 401 })));

  it("una configuración rota abre el circuito tras 2 conversaciones: la 3ª NO gasta llamadas, NO escala, sigue recuperable y no promete un humano", async () => {
    const fetchMock = unauthorized();
    vi.stubGlobal("fetch", fetchMock);

    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handoffs()).toHaveLength(2); // las dos que fallaron antes de detectar lo global
    expect(consoleOutput.join("\n")).toContain("event=circuit_open");
    expect(consoleOutput.join("\n")).toContain("code=unauthorized");

    updates.length = 0;
    queueTurn({ conv: convOf("cv_C") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2); // ni una llamada más
    expect(handoffs()).toEqual([]); // sin handoff independiente
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(sentTexts()[0]).not.toMatch(/humano|persona|asesor|compañero|equipo/i);
    // la conversación queda con la IA activa y con el aviso marcado
    expect(updates.some((u) => u.set.aiFailKind === "circuit_open")).toBe(true);
    expect(consoleOutput.join("\n")).toContain("event=circuit_blocked");
  });

  it("la misma conversación no recibe el aviso en cada mensaje mientras el circuito sigue abierto", async () => {
    vi.stubGlobal("fetch", unauthorized());
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    sendText.mockClear();

    queueTurn({
      conv: convOf("cv_C", { aiFailKind: "circuit_open", aiFailAt: new Date() }),
    });
    await runTurn();
    expect(sendText).not.toHaveBeenCalled();
    expect(handoffs()).toHaveLength(2);
  });

  it("un fallo AISLADO (una sola conversación, o de formato) no abre el circuito", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(providerJson('{"action":"???"}')));
    vi.stubGlobal("fetch", fetchMock);
    for (const id of ["cv_1", "cv_2", "cv_3", "cv_4"]) {
      failState.count = 0;
      queueTurn({ conv: convOf(id) });
      await runTurn();
    }
    // los 4 turnos llamaron al proveedor (2 llamadas c/u: principal + corrección): nunca se bloqueó
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(consoleOutput.join("\n")).not.toContain("circuit_open");
    expect(consoleOutput.join("\n")).not.toContain("circuit_blocked");
  });

  it("un éxito cierra la racha: dos fallos separados por un turno bueno no abren el circuito", async () => {
    let mode: "bad" | "good" = "bad";
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mode === "bad"
          ? new Response("no", { status: 401 })
          : providerJson('{"action":"reply","text":"ok"}')
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    mode = "good";
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    mode = "bad";
    queueTurn({ conv: convOf("cv_C") });
    await runTurn();
    expect(consoleOutput.join("\n")).not.toContain("circuit_open");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("tras el enfriamiento, UN turno de prueba: si sale bien, el circuito cierra y todo vuelve a la normalidad", async () => {
    vi.useFakeTimers();
    let mode: "bad" | "good" = "bad";
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mode === "bad"
          ? new Response("no", { status: 401 })
          : providerJson('{"action":"reply","text":"Ya funciona"}')
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    expect(consoleOutput.join("\n")).toContain("event=circuit_open");

    // aún en enfriamiento → bloqueado
    queueTurn({ conv: convOf("cv_C") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // pasa el enfriamiento y el operador corrigió la credencial
    vi.setSystemTime(Date.now() + 6 * 60_000);
    mode = "good";
    sendText.mockClear();
    queueTurn({ conv: convOf("cv_D") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(3); // el turno de prueba
    expect(sentTexts()).toEqual(["Ya funciona"]);
    expect(consoleOutput.join("\n")).toContain("event=circuit_closed");

    // cerrado: el siguiente pasa directo
    queueTurn({ conv: convOf("cv_E") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("un 401 marca la conexión de IA de la organización como `error` (señal visible en Ajustes → IA)", async () => {
    vi.stubGlobal("fetch", unauthorized());
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    expect(updates.some((u) => u.set.status === "error")).toBe(true);
  });

  it("modelo inexistente en dos conversaciones también abre el circuito (config), y la señal no lleva contenido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 })
        )
      )
    );
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    const logs = consoleOutput.join("\n");
    expect(logs).toContain("event=circuit_open");
    expect(logs).toContain("code=model_not_found");
    expect(logs).toContain("org=org_1");
    expect(logs).not.toContain("hipopótamos");
    expect(logs).not.toContain("token-test");
  });

  it("el circuito es por organización+modelo: otra organización sigue llamando", async () => {
    const fetchMock = unauthorized();
    vi.stubGlobal("fetch", fetchMock);
    queueTurn({ conv: convOf("cv_A") });
    await runTurn();
    queueTurn({ conv: convOf("cv_B") });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // otra organización (mismo modelo de entorno): el circuito de la primera no la bloquea
    queueTurn({ conv: convOf("cv_Z", { organizationId: "org_2" }) });
    await runTurn();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
