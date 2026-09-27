import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT,
  circuitCheck,
  circuitRecordFailure,
  circuitRecordSuccess,
  countsTowardCircuit,
  resetCircuitState,
} from "@/server/ai/circuit";

const ORG = "org_1";
const MODEL = "modelo-x";
const T0 = 1_000_000;

describe("circuito de protección por organización + modelo", () => {
  beforeEach(() => {
    resetCircuitState();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("qué cuenta: configuración y transporte sí; formato y not_configured NO", () => {
    for (const c of [
      "unauthorized",
      "model_not_found",
      "schema_rejected",
      "invalid_request",
      "unsupported_response_format",
      "rate_limited",
      "timeout",
      "network_error",
      "provider_error",
    ] as const) {
      expect(countsTowardCircuit(c), c).toBe(true);
    }
    for (const c of ["invalid_json", "invalid_schema", "not_configured"] as const) {
      expect(countsTowardCircuit(c), c).toBe(false);
    }
  });

  it("un fallo AISLADO (una sola conversación) no abre el circuito", () => {
    const r1 = circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    const r2 = circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0 + 1);
    expect(r1.opened || r2.opened).toBe(false);
    expect(circuitCheck(ORG, MODEL, T0 + 2)).toEqual({ allow: true, probe: false });
  });

  it("configuración: 2 fallos en 2 conversaciones distintas abren el circuito", () => {
    expect(circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0).opened).toBe(false);
    expect(circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0 + 10).opened).toBe(true);
    const gate = circuitCheck(ORG, MODEL, T0 + 20);
    expect(gate.allow).toBe(false);
    if (!gate.allow) {
      expect(gate.code).toBe("unauthorized");
      expect(gate.retryAtMs).toBe(T0 + 10 + CIRCUIT.baseCooldownMs);
    }
  });

  it("transporte: hacen falta 3 (un bache de 2 no abre)", () => {
    expect(circuitRecordFailure(ORG, MODEL, "cv_1", "provider_error", T0).opened).toBe(false);
    expect(circuitRecordFailure(ORG, MODEL, "cv_2", "provider_error", T0 + 1).opened).toBe(false);
    expect(circuitRecordFailure(ORG, MODEL, "cv_3", "provider_error", T0 + 2).opened).toBe(true);
  });

  it("un éxito entre fallos borra la racha", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordSuccess(ORG, MODEL);
    expect(circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0 + 1).opened).toBe(false);
  });

  it("los fallos viejos (fuera de la ventana) no suman: no es una racha", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    const later = T0 + CIRCUIT.windowMs + 1;
    expect(circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", later).opened).toBe(false);
  });

  it("es POR organización y por modelo: otra organización u otro modelo siguen abiertos", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0 + 1);
    expect(circuitCheck(ORG, MODEL, T0 + 2).allow).toBe(false);
    expect(circuitCheck("org_2", MODEL, T0 + 2).allow).toBe(true);
    expect(circuitCheck(ORG, "otro-modelo", T0 + 2).allow).toBe(true);
  });

  it("tras el enfriamiento, UN turno de prueba; los demás siguen bloqueados", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0);
    const after = T0 + CIRCUIT.baseCooldownMs + 1;
    expect(circuitCheck(ORG, MODEL, after)).toEqual({ allow: true, probe: true });
    expect(circuitCheck(ORG, MODEL, after + 5).allow).toBe(false); // ya hay una prueba en vuelo
  });

  it("la prueba que sale bien CIERRA el circuito", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0);
    const after = T0 + CIRCUIT.baseCooldownMs + 1;
    circuitCheck(ORG, MODEL, after);
    circuitRecordSuccess(ORG, MODEL);
    expect(circuitCheck(ORG, MODEL, after + 1)).toEqual({ allow: true, probe: false });
  });

  it("la prueba que falla REABRE con enfriamiento doble (tope 30 min)", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0);
    let now = T0 + CIRCUIT.baseCooldownMs + 1;
    circuitCheck(ORG, MODEL, now); // prueba
    expect(circuitRecordFailure(ORG, MODEL, "cv_3", "unauthorized", now).opened).toBe(true);
    const gate = circuitCheck(ORG, MODEL, now + 1);
    expect(gate.allow).toBe(false);
    if (!gate.allow) expect(gate.retryAtMs).toBe(now + CIRCUIT.baseCooldownMs * 2);
    // reaperturas sucesivas no pasan del tope
    for (let i = 0; i < 6; i++) {
      now += CIRCUIT.maxCooldownMs + 1;
      circuitCheck(ORG, MODEL, now);
      circuitRecordFailure(ORG, MODEL, "cv_x", "unauthorized", now);
    }
    const g = circuitCheck(ORG, MODEL, now + 1);
    if (!g.allow) expect(g.retryAtMs - now).toBeLessThanOrEqual(CIRCUIT.maxCooldownMs);
  });

  it("si la prueba nunca reporta (excepción), otro turno puede probar tras el timeout", () => {
    circuitRecordFailure(ORG, MODEL, "cv_1", "unauthorized", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "unauthorized", T0);
    const first = T0 + CIRCUIT.baseCooldownMs + 1;
    circuitCheck(ORG, MODEL, first);
    expect(circuitCheck(ORG, MODEL, first + CIRCUIT.probeTimeoutMs + 1)).toEqual({
      allow: true,
      probe: true,
    });
  });

  it("la señal operativa (log) lleva organización, modelo, código y enfriamiento — y nada más", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    circuitRecordFailure(ORG, MODEL, "cv_1", "model_not_found", T0);
    circuitRecordFailure(ORG, MODEL, "cv_2", "model_not_found", T0);
    const line = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("event=circuit_open");
    expect(line).toContain("org=org_1");
    expect(line).toContain("model=modelo-x");
    expect(line).toContain("code=model_not_found");
    expect(line).toContain("cooldownSec=300");
    expect(line).not.toContain("cv_1"); // ni siquiera ids de conversación
  });
});
