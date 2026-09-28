import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 024 §5.6 — `resendText` rechaza ANTES de tocar el outbox: otra
 * organización o conversación, un estado que no admite reenvío, o una oferta que
 * ya no es vigente. (El comportamiento con Postgres real y la carrera de dos
 * operadores están en tests/integration/outbound-offer-guard.test.ts.)
 */

const enqueueText = vi.fn();
const attemptDelivery = vi.fn();
vi.mock("@/server/outbox", () => ({ enqueueText, attemptDelivery }));

const blockReasonForManualResend = vi.fn();
vi.mock("@/server/agenda/offer-resend-guard", () => ({ blockReasonForManualResend }));

vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: vi.fn(),
  markReconnectRequired: vi.fn(),
}));

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
  chain.limit = () => Promise.resolve(rows);
  return chain;
}
const selectRows: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => makeChain(selectRows.shift() ?? []) }),
  schema: {
    message: {
      id: "id",
      conversationId: "conversationId",
      direction: "direction",
      type: "type",
      status: "status",
      text: "text",
      organizationId: "organizationId",
    },
  },
}));

const ROW = {
  id: "msg_1",
  conversationId: "cv_1",
  direction: "out",
  type: "text",
  status: "failed",
  text: "payload original",
};

beforeEach(() => {
  enqueueText.mockReset();
  attemptDelivery.mockReset();
  blockReasonForManualResend.mockReset();
  blockReasonForManualResend.mockResolvedValue(null);
  selectRows.length = 0;
});

describe("resendText — rechazos previos a cualquier envío", () => {
  it("un mensaje de OTRA organización (la consulta no lo encuentra) → no encontrado", async () => {
    const { resendText } = await import("@/server/inbox/send");
    selectRows.push([]); // el filtro por organización no devuelve nada
    await expect(resendText({ messageId: "msg_1", organizationId: "org_otra" })).rejects.toThrow(
      /no encontrado/i
    );
    expect(attemptDelivery).not.toHaveBeenCalled();
    expect(blockReasonForManualResend).not.toHaveBeenCalled();
  });

  it("un mensaje de OTRA conversación → no encontrado", async () => {
    const { resendText } = await import("@/server/inbox/send");
    selectRows.push([ROW]);
    await expect(
      resendText({ messageId: "msg_1", organizationId: "org_1", conversationId: "cv_distinta" })
    ).rejects.toThrow(/no encontrado/i);
    expect(attemptDelivery).not.toHaveBeenCalled();
  });

  it("un ENTRANTE no se reenvía", async () => {
    const { resendText } = await import("@/server/inbox/send");
    selectRows.push([{ ...ROW, direction: "in" }]);
    await expect(resendText({ messageId: "msg_1", organizationId: "org_1" })).rejects.toThrow(
      /no encontrado/i
    );
  });

  it.each(["queued", "sending", "retrying", "pending", "sent", "delivered", "read"])(
    "estado %s NO admite reenvío manual → resend_conflict (409), sin consultar el guard ni enviar",
    async (status) => {
      const { resendText } = await import("@/server/inbox/send");
      selectRows.push([{ ...ROW, status }]);
      await expect(resendText({ messageId: "msg_1", organizationId: "org_1" })).rejects.toMatchObject({
        code: "resend_conflict",
      });
      expect(blockReasonForManualResend).not.toHaveBeenCalled();
      expect(attemptDelivery).not.toHaveBeenCalled();
    }
  );

  it("un adjunto (sin texto) no se reenvía como texto", async () => {
    const { resendText } = await import("@/server/inbox/send");
    selectRows.push([{ ...ROW, type: "image", text: null }]);
    await expect(resendText({ messageId: "msg_1", organizationId: "org_1" })).rejects.toThrow(
      /sólo se pueden reenviar mensajes de texto/i
    );
  });

  it.each(["failed", "delivery_unknown"])(
    "oferta que ya no es vigente (estado %s) → offer_stale y NO se llama al outbox",
    async (status) => {
      const { resendText } = await import("@/server/inbox/send");
      selectRows.push([{ ...ROW, status }]);
      blockReasonForManualResend.mockResolvedValue("later_round");
      await expect(resendText({ messageId: "msg_1", organizationId: "org_1" })).rejects.toMatchObject({
        code: "offer_stale",
        message: expect.stringMatching(/nueva ronda con la disponibilidad actualizada/),
      });
      expect(attemptDelivery).not.toHaveBeenCalled();
      expect(enqueueText).not.toHaveBeenCalled(); // jamás crea un mensaje nuevo
    }
  );
});
