import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-09-16 — Bug reportado: hubo mensajes no entregados (Meta 131026) que
 * el CRM nunca mostró como fallidos — a diferencia de un adjunto
 * (`sendMediaMessage`), un rechazo SÍNCRONO de Meta al mandar TEXTO
 * (`sendText`, la vía que usa el agente para sus respuestas) no dejaba
 * ningún rastro: ni burbuja "failed" en el hilo, ni fila en `message`. El
 * prospecto se quedaba sin nada y nadie se enteraba.
 *
 * Estos tests fijan que un rechazo real de Meta (o un destinatario sin
 * teléfono/identidad utilizable) SIEMPRE deja un mensaje "failed" visible con
 * el motivo traducido (`describeSendError`), y que los códigos que YA tienen
 * su propia UX (ventana cerrada → traspaso; sin conexión/token vencido →
 * banner de Ajustes; sandbox del Laboratorio) NO generan una burbuja
 * duplicada.
 */

const graphRequest = vi.fn();
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

const getCredentialsByOrg = vi.fn();
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg,
  markReconnectRequired: vi.fn(),
}));

vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));

// 024: el envío de texto pasa por el outbox (persistir ANTES de intentar). La
// política y los intentos se prueban en tests/unit/outbox-policy.test.ts y en
// tests/integration/outbound-*.test.ts (Postgres real); aquí sólo el contrato
// de `sendText` hacia sus llamadores.
const enqueueText = vi.fn();
const attemptDelivery = vi.fn();
vi.mock("@/server/outbox", () => ({ enqueueText, attemptDelivery }));

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy"]) {
    chain[m] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

const selectRows: unknown[][] = [];
const inserted: { values: Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => makeChain(selectRows.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ values });
        return {
          returning: () =>
            Promise.resolve([
              { ...values, id: "msg_1", createdAt: new Date(), waTimestamp: null },
            ]),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  }),
  schema: {
    conversation: { contactId: "contactId", id: "id" },
    contact: { id: "id" },
    message: {},
  },
}));

const CONTACT = { id: "ct_1", phone: "5215511111111" };
function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    conversation: {
      id: "cv_1",
      organizationId: "org_1",
      isTest: false,
      channel: "whatsapp",
      lastInboundAt: new Date(),
      ...overrides,
    },
    contact: CONTACT,
  };
}

describe("sendText — un rechazo real de Meta queda visible", () => {
  beforeEach(() => {
    graphRequest.mockReset();
    enqueueText.mockReset();
    attemptDelivery.mockReset();
    getCredentialsByOrg.mockReset();
    selectRows.length = 0;
    inserted.length = 0;
    getCredentialsByOrg.mockResolvedValue({
      token: "token-test",
      phoneNumberId: "pnid_1",
      organizationId: "org_1",
    });
  });

  it("persiste el payload ANTES del primer intento y un rechazo definitivo (131026) lanza SendError con messageId", async () => {
    const { sendText, SendError } = await import("@/server/inbox/send");
    const order: string[] = [];
    enqueueText.mockImplementation(async () => {
      order.push("enqueue");
      return { message: { id: "msg_9", status: "queued" }, created: true };
    });
    attemptDelivery.mockImplementation(async () => {
      order.push("attempt");
      return {
        claimed: true,
        messageId: "msg_9",
        attemptNo: 1,
        outcome: "failed",
        class: "recipient_unavailable",
        sendError: new SendError("meta_error", "El destinatario no puede recibir (Meta 131026)"),
      };
    });
    selectRows.push([conversationRow()]);

    await expect(
      sendText({
        conversationId: "cv_1",
        organizationId: "org_1",
        text: "hola",
        aiGenerated: true,
        dedupeKey: "agent-turn:msg_in",
      })
    ).rejects.toMatchObject({
      code: "meta_error",
      messageId: "msg_9",
      message: expect.stringMatching(/no puede recibir/i),
    });

    expect(order).toEqual(["enqueue", "attempt"]);
    expect(enqueueText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hola",
        origin: "ai",
        aiGenerated: true,
        dedupeKey: "agent-turn:msg_in",
      })
    );
    // El intento lee el payload de la base: sólo recibe el id (y el destino).
    expect(attemptDelivery).toHaveBeenCalledWith("msg_9", expect.anything());
    expect(graphRequest).not.toHaveBeenCalled(); // el transporte es del outbox
  });

  it("un fallo RECUPERABLE no lanza: el mensaje ya existe y el outbox lo reintenta", async () => {
    const { sendText } = await import("@/server/inbox/send");
    enqueueText.mockResolvedValue({ message: { id: "msg_7", status: "queued" }, created: true });
    attemptDelivery.mockResolvedValue({
      claimed: true,
      messageId: "msg_7",
      attemptNo: 1,
      outcome: "retrying",
    });
    selectRows.push([conversationRow()]);

    await expect(
      sendText({ conversationId: "cv_1", organizationId: "org_1", text: "hola", aiGenerated: true })
    ).resolves.toEqual({ messageId: "msg_7", status: "retrying" });
  });

  it("la MISMA respuesta lógica (dedupeKey ya existente) no se vuelve a enviar", async () => {
    const { sendText } = await import("@/server/inbox/send");
    enqueueText.mockResolvedValue({ message: { id: "msg_5", status: "pending" }, created: false });
    selectRows.push([conversationRow()]);

    const res = await sendText({
      conversationId: "cv_1",
      organizationId: "org_1",
      text: "hola",
      aiGenerated: true,
      dedupeKey: "agent-turn:msg_in",
    });
    expect(res).toEqual({ messageId: "msg_5", status: "pending" });
    expect(attemptDelivery).not.toHaveBeenCalled();
  });

  it("contacto sin teléfono ni identidad utilizable → 'failed' visible, no un silencio total", async () => {
    selectRows.push([
      {
        conversation: {
          id: "cv_1",
          organizationId: "org_1",
          isTest: false,
          channel: "whatsapp",
          lastInboundAt: new Date(),
        },
        contact: { id: "ct_2", phone: null, waUserId: null },
      },
    ]);
    const { sendText } = await import("@/server/inbox/send");

    await expect(
      sendText({
        conversationId: "cv_1",
        organizationId: "org_1",
        text: "hola",
        aiGenerated: true,
      })
    ).rejects.toMatchObject({ code: "meta_error" });

    expect(graphRequest).not.toHaveBeenCalled();
    const failedInsert = inserted.find((i) => i.values.status === "failed");
    expect(failedInsert).toBeDefined();
    expect(failedInsert!.values.error).toMatch(/no tiene teléfono/i);
  });

  it("ventana cerrada → SIN burbuja 'failed' duplicada (ya se convierte en traspaso aparte)", async () => {
    selectRows.push([conversationRow({ lastInboundAt: null })]);
    const { sendText } = await import("@/server/inbox/send");

    await expect(
      sendText({ conversationId: "cv_1", organizationId: "org_1", text: "hola" })
    ).rejects.toMatchObject({ code: "window_closed" });

    expect(inserted.length).toBe(0);
    expect(graphRequest).not.toHaveBeenCalled();
  });
});
