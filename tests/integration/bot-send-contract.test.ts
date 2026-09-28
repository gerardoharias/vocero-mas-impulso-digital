import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { harness } from "./setup";
import {
  bootScenario,
  outboundRows,
  resetData,
  sentBodies,
  teardownScenario,
  waitUntil,
} from "./helpers/scenario";

/**
 * Contrato v2 de `POST /api/bot/messages` (spec 024 §5.5, docs/bot-messages-contrato.md).
 *
 *   v1 (≤ 023): un fallo temporal de Meta → 502/503.
 *   v2 (024)  : un fallo RECUPERABLE → 200 {status:"retrying"}; ambiguo → 200
 *               {status:"delivery_unknown"}; sólo un rechazo definitivo es error.
 *
 * Y la garantía de que un reintento NO dispara al agente integrado (aunque esté
 * encendido): ni IA, ni pipeline, ni otro mensaje.
 */

const KEY = "bot-key-integration-0123456789";
const T503 = { ok: false, status: 503, code: 2 } as const;

beforeAll(async () => {
  await bootScenario();
});
afterAll(teardownScenario);
beforeEach(async () => {
  harness.reset();
  await resetData();
});

async function makeConversation(opts: { lastInboundAgoMs?: number } = {}) {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/db/ids");
  const db = getDb();
  const org = (await db.select({ id: schema.organization.id }).from(schema.organization).limit(1))[0]!.id;
  const contactId = newId("contact");
  await db.insert(schema.contact).values({
    id: contactId,
    organizationId: org,
    waIdentity: "5215500000077",
    phone: "5215500000077",
    name: "Prospecto de prueba",
  });
  const conversationId = newId("conversation");
  await db.insert(schema.conversation).values({
    id: conversationId,
    organizationId: org,
    contactId,
    lastInboundAt: new Date(Date.now() - (opts.lastInboundAgoMs ?? 60_000)),
  });
  return conversationId;
}

async function post(conversationId: string, text: string, key: string | null = KEY) {
  const { POST } = await import("@/app/api/bot/messages/route");
  const res = await POST(
    new Request("http://localhost/api/bot/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify({ conversationId, text }),
    })
  );
  // `handleBotSend` lee el cuerpo por su cuenta: se entrega una copia sin consumir.
  const copy = res.clone();
  return {
    res: copy,
    json: (await res.json()) as {
      messageId?: string;
      status?: string | null;
      contract?: number;
      error: { code: string; message: string };
    },
  };
}

/**
 * EJEMPLO DE MANEJO CORRECTO para un cerebro externo (idéntico al de
 * docs/bot-messages-contrato.md). Se prueba aquí para que la documentación no
 * pueda mentir.
 */
type BotSendResult =
  | { action: "done" } // el mensaje va o ya salió: NO reenviar
  | { action: "wait" } // el CRM lo reintenta solo: NO reenviar
  | { action: "ask_human" } // no se sabe si llegó: NO reenviar solo
  | { action: "stop"; reason: string } // rechazo definitivo: replantear, no reintentar igual
  | { action: "pause" }; // la IA está en pausa (409 ai_paused)

async function handleBotSend(res: Response): Promise<BotSendResult> {
  const body = (await res.clone().json()) as {
    status?: string | null;
    error?: { code?: string };
  };
  if (res.ok) {
    switch (body.status) {
      case "retrying":
        return { action: "wait" };
      case "delivery_unknown":
        return { action: "ask_human" };
      default:
        return { action: "done" }; // "pending" | "sent" | …
    }
  }
  if (res.status === 409 && body.error?.code === "ai_paused") return { action: "pause" };
  return { action: "stop", reason: body.error?.code ?? `http_${res.status}` };
}

describe("POST /api/bot/messages — contrato v2", () => {
  it("aceptado: 200 con status, versión de contrato y header", async () => {
    const cv = await makeConversation();
    const { res, json } = await post(cv, "Hola, ¿en qué te ayudo?");
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ status: "pending", contract: 2 });
    expect(json.messageId).toMatch(/^msg_/);
    expect(res.headers.get("X-Vocero-Send-Contract")).toBe("2");
    expect(await handleBotSend(res)).toEqual({ action: "done" });
  });

  it("fallo TEMPORAL de Meta: 200 {status:'retrying'} (antes 502) y el CRM reenvía SOLO, íntegro", async () => {
    const cv = await makeConversation();
    harness.meta.script.push(T503, { ok: true, wamid: "wamid.OUT.BOT" });
    const { res, json } = await post(cv, "Texto largo\ncon saltos de línea\ny un enlace https://ej.test/x");

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ status: "retrying", contract: 2 });
    expect(await handleBotSend(res)).toEqual({ action: "wait" });

    const sent = await waitUntil(async () => (await outboundRows()).find((m) => m.status === "pending"), {
      label: "aceptado tras el reintento",
    });
    expect(sent.id).toBe(json.messageId); // la MISMA burbuja
    expect(sentBodies()).toEqual([
      "Texto largo\ncon saltos de línea\ny un enlace https://ej.test/x",
      "Texto largo\ncon saltos de línea\ny un enlace https://ej.test/x",
    ]);
    expect(await outboundRows()).toHaveLength(1);
  });

  it("GARANTÍA: con el agente integrado ENCENDIDO, el reintento no genera IA, pipeline ni otro envío", async () => {
    // El perfil del agente está `enabled: true` en el escenario.
    const cv = await makeConversation();
    harness.meta.script.push(T503, { ok: true });
    const { json } = await post(cv, "Respuesta del cerebro externo");
    await waitUntil(async () => (await outboundRows()).find((m) => m.status === "pending"), {
      label: "reintento aceptado",
    });
    await new Promise((r) => setTimeout(r, 300)); // espacio para que algo AJENO saliera

    expect(harness.ai.calls).toBe(0);
    expect(harness.counts.pipelineRuns).toBe(0);
    expect(harness.counts.offerSlots).toBe(0);
    expect(harness.availability.calls).toBe(0);
    expect(harness.meta.calls).toHaveLength(2); // el fallo + UN reintento, nada más
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(json.messageId);
    expect(out[0]!.dedupeKey).toBeNull(); // no es una respuesta del agente
  });

  it("resultado AMBIGUO (502 sin cuerpo de Meta): 200 {status:'delivery_unknown'} y NO se reenvía solo", async () => {
    const cv = await makeConversation();
    harness.meta.script.push({ ok: false, status: 502 });
    const { res, json } = await post(cv, "Mensaje ambiguo");
    expect(res.status).toBe(200);
    expect(json.status).toBe("delivery_unknown");
    expect(await handleBotSend(res)).toEqual({ action: "ask_human" });
    await new Promise((r) => setTimeout(r, 400));
    expect(harness.meta.calls).toHaveLength(1);
    expect((await outboundRows())[0]!.status).toBe("delivery_unknown");
  });

  it("rechazo DEFINITIVO (131026): sigue siendo error (502) con su código, sin reintento", async () => {
    const cv = await makeConversation();
    harness.meta.script.push({ ok: false, status: 400, code: 131026 });
    const { res, json } = await post(cv, "Mensaje a un número inexistente");
    expect(res.status).toBe(502);
    expect(json.error.code).toBe("meta_error");
    expect(json.error.message).toMatch(/131026/);
    expect(await handleBotSend(res)).toEqual({ action: "stop", reason: "meta_error" });
    await new Promise((r) => setTimeout(r, 300));
    expect(harness.meta.calls).toHaveLength(1);
    expect((await outboundRows())[0]!.status).toBe("failed");
  });

  it("ventana de 24 h cerrada: 409 window_closed, sin fila ni intento (contrato sin cambio)", async () => {
    const cv = await makeConversation({ lastInboundAgoMs: 30 * 3_600_000 });
    const { res, json } = await post(cv, "Tarde");
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("window_closed");
    expect(harness.meta.calls).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
  });

  it("IA en pausa: 409 ai_paused (sin cambio)", async () => {
    const cv = await makeConversation();
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    await getDb().update(schema.conversation).set({ aiEnabled: false }).where(eq(schema.conversation.id, cv));
    const { res, json } = await post(cv, "Hola");
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("ai_paused");
    expect(await handleBotSend(res)).toEqual({ action: "pause" });
  });

  it("sin API key: 401 (sin cambio)", async () => {
    const cv = await makeConversation();
    const { res } = await post(cv, "Hola", null);
    expect(res.status).toBe(401);
    expect(harness.meta.calls).toHaveLength(0);
  });
});
