import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El enganche de "escribiendo…" en la ingesta (2026-09-21).
 *
 * La señal se enciende SOLO si el agente de verdad va a responder: una señal
 * sin respuesta detrás es peor que no señalar nada. Y encender los puntitos
 * jamás puede tumbar la ingesta de un mensaje.
 */

const mocks = vi.hoisted(() => ({
  scheduleAgentTurn: vi.fn(),
  markReadAndTyping: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
  isAgentEnabledForOrg: vi.fn(async () => true),
}));

vi.mock("@/server/ai/pipeline", () => ({
  scheduleAgentTurn: mocks.scheduleAgentTurn,
}));
vi.mock("@/server/whatsapp/presence", () => ({
  markReadAndTyping: mocks.markReadAndTyping,
}));
vi.mock("@/server/ai/eligibility", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/ai/eligibility")>();
  return { ...original, isAgentEnabledForOrg: mocks.isAgentEnabledForOrg };
});

const CONV = {
  id: "cv_1",
  organizationId: "org_1",
  channel: "whatsapp" as const,
  isTest: false,
  aiEnabled: true,
  handoffAt: null as Date | null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const conv = CONV as any;

describe("maybeRunAgentTurn — cuándo se enciende la señal", () => {
  beforeEach(() => {
    mocks.scheduleAgentTurn.mockReset();
    mocks.markReadAndTyping.mockReset();
    mocks.markReadAndTyping.mockResolvedValue({ ok: true });
    mocks.isAgentEnabledForOrg.mockReset();
    mocks.isAgentEnabledForOrg.mockResolvedValue(true);
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("sin IA configurada no se agenda turno ni se señala", async () => {
    vi.stubEnv("OPENROUTER_API_TOKEN", "");
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");

    await maybeRunAgentTurn(conv, { waMessageId: "w" });

    expect(mocks.scheduleAgentTurn).not.toHaveBeenCalled();
    expect(mocks.markReadAndTyping).not.toHaveBeenCalled();
  });

  it("conversación elegible: se agenda el turno Y se enciende con ESE wamid", async () => {
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");

    await maybeRunAgentTurn(conv, { waMessageId: "wamid.ABC" });

    expect(mocks.scheduleAgentTurn).toHaveBeenCalledWith("cv_1");
    expect(mocks.markReadAndTyping).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: conv, waMessageId: "wamid.ABC" })
    );
  });

  it("con el agente apagado en Ajustes NO se señala, pero el turno se agenda igual", async () => {
    // El turno se agenda siempre: el cambio es aditivo y no toca el coalesce.
    // Pero los puntitos serían una mentira, porque nadie va a responder.
    mocks.isAgentEnabledForOrg.mockResolvedValue(false);
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");

    await maybeRunAgentTurn(conv, { waMessageId: "w" });

    expect(mocks.scheduleAgentTurn).toHaveBeenCalledOnce();
    expect(mocks.markReadAndTyping).not.toHaveBeenCalled();
  });

  it("con handoff o IA pausada tampoco se señala", async () => {
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeRunAgentTurn({ ...CONV, handoffAt: new Date() } as any, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeRunAgentTurn({ ...CONV, aiEnabled: false } as any, {});

    expect(mocks.markReadAndTyping).not.toHaveBeenCalled();
    // Y sin gastar la query del perfil.
    expect(mocks.isAgentEnabledForOrg).not.toHaveBeenCalled();
  });

  it("si la señal revienta, la ingesta del mensaje NO se rompe", async () => {
    mocks.markReadAndTyping.mockRejectedValue(new Error("boom"));
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");

    await expect(
      maybeRunAgentTurn(conv, { waMessageId: "w" })
    ).resolves.toBeUndefined();
    expect(mocks.scheduleAgentTurn).toHaveBeenCalledOnce();
  });
});
