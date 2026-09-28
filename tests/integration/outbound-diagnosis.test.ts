import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { harness } from "./setup";
import {
  PHONE_NUMBER_ID,
  bootScenario,
  deliverInbound,
  resetData,
  settle,
  teardownScenario,
} from "./helpers/scenario";

/**
 * Fase 1 — hipótesis DESCARTADAS con evidencia (spec 024 §1.4).
 *
 * Estas dos pasan contra el código anterior y siguen pasando después: son la
 * prueba de que ni la ingesta ni un callback de estado eran la causa, y el
 * seguro de que no lo serán.
 */

describe("diagnóstico: hipótesis descartadas", () => {
  beforeAll(async () => {
    await bootScenario();
  });
  afterAll(teardownScenario);
  beforeEach(async () => {
    harness.reset();
    await resetData();
  });

  it("H3 — el MISMO evento entrante entregado dos veces (y en paralelo) no re-ejecuta agente ni agenda", async () => {
    const wamid = "wamid.IN.DUPLICADO";
    // Meta reintenta webhooks: mismo id, secuencial y en paralelo.
    await deliverInbound({ text: "Sí, quiero agendar", wamid });
    await Promise.all([
      deliverInbound({ text: "Sí, quiero agendar", wamid }),
      deliverInbound({ text: "Sí, quiero agendar", wamid }),
    ]);
    const snap = await settle();

    expect(snap.messages.filter((m) => m.direction === "in")).toHaveLength(1);
    expect(harness.counts.pipelineRuns).toBe(1);
    expect(harness.ai.calls).toBe(1);
    expect(harness.availability.calls).toBe(1);
    expect(harness.counts.offerSlots).toBe(1);
    expect(snap.messages.filter((m) => m.direction === "out")).toHaveLength(1);
  });

  it("H6 — un callback de estado `failed` sólo toca el mensaje de su wamid y no dispara al agente", async () => {
    // Un turno simple: el modelo responde con texto y Meta acepta.
    harness.ai.script.push({
      ok: true,
      data: { action: "reply", text: "Con gusto te ayudo." },
      raw: "{}",
    });
    harness.meta.script.push({ ok: true, wamid: "wamid.OUT.CALLBACK" });
    await deliverInbound({ text: "Hola, ¿me ayudas?" });
    await settle();
    const before = { runs: harness.counts.pipelineRuns, ai: harness.ai.calls };

    const { processMessagesValue } = await import("@/server/inbox/ingest");
    await processMessagesValue({
      messaging_product: "whatsapp",
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      statuses: [
        {
          id: "wamid.OUT.CALLBACK",
          status: "failed",
          timestamp: String(Math.floor(Date.now() / 1000)),
          errors: [{ code: 131026, title: "Message undeliverable" }],
        },
      ],
    });
    const snap = await settle();

    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.waMessageId).toBe("wamid.OUT.CALLBACK");
    expect(harness.counts.pipelineRuns).toBe(before.runs);
    expect(harness.ai.calls).toBe(before.ai);
    expect(harness.meta.calls).toHaveLength(1);
  });
});
