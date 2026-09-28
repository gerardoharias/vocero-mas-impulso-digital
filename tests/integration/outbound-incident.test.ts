import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, INCIDENT_INTRO } from "./setup";
import {
  bootScenario,
  deliverInbound,
  resetData,
  settle,
  sentBodies,
  teardownScenario,
  traceOf,
} from "./helpers/scenario";

/**
 * Regresión del INCIDENTE REAL (spec 024): un prospecto aceptó agendar; la
 * acción `offer_slots` armó
 *
 *   ¡Perfecto! Te comparto los horarios disponibles para tu llamada inicial sin costo.
 *   • lunes, 21 de septiembre a las 09:00
 *   • martes, 22 de septiembre a las 09:00
 *   • miércoles, 23 de septiembre a las 09:00
 *
 * Meta rechazó el envío de forma temporal (el CRM mostró «No se entregó. Meta
 * no está disponible ahora») y un minuto después apareció ENTREGADO otro
 * mensaje: sólo la introducción. El prospecto no pudo elegir horario.
 *
 * Este archivo se escribió ANTES de la corrección (Fase 1): contra el código
 * anterior falla, y su traza (`console.log`) documenta la causa. No depende de
 * ninguna API nueva: sólo de lo observable — lo que llega a Meta y lo que queda
 * en la base.
 */

const FULL_MESSAGE = [
  INCIDENT_INTRO,
  "• lunes, 21 de septiembre a las 09:00",
  "• martes, 22 de septiembre a las 09:00",
  "• miércoles, 23 de septiembre a las 09:00",
].join("\n");

describe("incidente: offer_slots + rechazo temporal de Meta", () => {
  beforeAll(async () => {
    // Antes del 21 de septiembre, para que las etiquetas sean las del
    // incidente y no "mañana lunes…". Sólo el reloj (Date); los timers reales.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-17T18:00:00Z"));
    await bootScenario();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await teardownScenario();
  });

  beforeEach(async () => {
    harness.reset();
    await resetData();
  });

  it("reproduce textualmente el incidente y exige que el reintento envíe el payload ÍNTEGRO", async () => {
    // 1er intento: Meta no disponible (temporal). 2º: acepta.
    harness.meta.script.push(
      { ok: false, status: 503, code: 2, message: "Service temporarily unavailable" },
      { ok: true, wamid: "wamid.OUT.RECOVERED" }
    );

    const { wamid } = await deliverInbound({
      text: "Sí, quiero agendar",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const snap = await settle();
    const trace = traceOf(snap, { inboundEvent: wamid });
    console.log("TRAZA-FASE-1", JSON.stringify(trace, null, 2));

    // --- Lo que el incidente NO puede volver a pasar ---------------------
    // El cuerpo del primer intento ES el mensaje completo del incidente.
    expect(sentBodies()[0]).toBe(FULL_MESSAGE);

    // Todo cuerpo que llegue a Meta es exactamente ese payload: ni una
    // introducción sola, ni un resumen, ni un fallback.
    for (const body of sentBodies()) expect(body).toBe(FULL_MESSAGE);

    // Una sola representación visible del mensaje lógico, y sin duplicados.
    const out = snap.messages.filter((m) => m.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(FULL_MESSAGE);
    expect(["pending", "sent", "delivered", "read"]).toContain(out[0]!.status);
    expect(out[0]!.waMessageId).toBe("wamid.OUT.RECOVERED");

    // Ningún reintento vuelve a llamar al modelo, al pipeline ni a la agenda.
    expect(trace.pipelineRuns).toBe(1);
    expect(trace.aiCalls).toBe(1);
    expect(trace.availabilityQueries).toBe(1);
    expect(trace.offerSlotsExecutions).toBe(1);
    expect(trace.handoffs).toBe(0);
  });
});
