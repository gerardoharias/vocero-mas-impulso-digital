import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 024 §5.6 — la lógica de decisión del guard de reenvío manual de ofertas,
 * aislada de la base (el comportamiento contra Postgres real está en
 * tests/integration/outbound-offer-guard.test.ts).
 */

const checkOfferFreshness = vi.fn();
const markOfferStale = vi.fn();
vi.mock("@/server/agenda/offer-freshness", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offer-freshness")>();
  return { ...original, checkOfferFreshness, markOfferStale };
});

const computeAvailability = vi.fn();
vi.mock("@/server/agenda/availability", () => ({ computeAvailability }));

const START_A = "2026-09-21T15:00:00.000Z";
const START_B = "2026-09-22T15:00:00.000Z";
const slot = (startUtc: string) => ({ startUtc, endUtc: startUtc, label: "x" });

beforeEach(() => {
  checkOfferFreshness.mockReset();
  markOfferStale.mockReset();
  computeAvailability.mockReset();
});

describe("blockReasonForManualResend", () => {
  it("un mensaje que NO es oferta se puede reenviar y no consulta la disponibilidad", async () => {
    const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
    checkOfferFreshness.mockResolvedValue({ applies: false });
    expect(await blockReasonForManualResend("msg_1")).toBeNull();
    expect(computeAvailability).not.toHaveBeenCalled();
    expect(markOfferStale).not.toHaveBeenCalled();
  });

  it("oferta vigente cuyos horarios el motor de HOY todavía ofrece → se permite", async () => {
    const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
    checkOfferFreshness.mockResolvedValue({
      applies: true,
      ok: true,
      shownStarts: [START_A, START_B],
      organizationId: "org_1",
    });
    computeAvailability.mockResolvedValue([slot(START_A), slot(START_B), slot("2026-09-23T15:00:00.000Z")]);
    expect(await blockReasonForManualResend("msg_1")).toBeNull();
    expect(markOfferStale).not.toHaveBeenCalled();
  });

  it("basta UN horario mostrado que el motor ya no ofrece: se bloquea completa (nada parcial)", async () => {
    const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
    checkOfferFreshness.mockResolvedValue({
      applies: true,
      ok: true,
      shownStarts: [START_A, START_B],
      organizationId: "org_1",
    });
    computeAvailability.mockResolvedValue([slot(START_A)]); // START_B ya no está
    expect(await blockReasonForManualResend("msg_1")).toBe("unavailable");
    expect(markOfferStale).toHaveBeenCalledWith("msg_1");
  });

  it.each(["superseded", "later_round", "no_offers"] as const)(
    "%s → se bloquea SIN consultar disponibilidad",
    async (reason) => {
      const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
      checkOfferFreshness.mockResolvedValue({ applies: true, ok: false, reason });
      expect(await blockReasonForManualResend("msg_1")).toBe(reason);
      expect(computeAvailability).not.toHaveBeenCalled();
    }
  );

  it.each(["expired", "occupied"] as const)(
    "%s es DEFINITIVO: se bloquea y la ronda queda marcada como obsoleta",
    async (reason) => {
      const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
      checkOfferFreshness.mockResolvedValue({ applies: true, ok: false, reason });
      expect(await blockReasonForManualResend("msg_1")).toBe(reason);
      expect(markOfferStale).toHaveBeenCalledWith("msg_1");
    }
  );

  it("una ronda posterior NO marca esta como obsoleta por sí sola (no toca nada)", async () => {
    const { blockReasonForManualResend } = await import("@/server/agenda/offer-resend-guard");
    checkOfferFreshness.mockResolvedValue({ applies: true, ok: false, reason: "later_round" });
    await blockReasonForManualResend("msg_1");
    expect(markOfferStale).not.toHaveBeenCalled();
  });
});

describe("mensaje al operador", () => {
  it("dice por qué se bloquea y qué hacer, para cada causa", async () => {
    const { staleMessage, STALE_COPY } = await import("@/server/agenda/offer-freshness");
    for (const reason of Object.keys(STALE_COPY) as (keyof typeof STALE_COPY)[]) {
      const msg = staleMessage(reason);
      expect(msg).toContain(STALE_COPY[reason]);
      expect(msg).toMatch(/nueva ronda/);
      expect(msg).toMatch(/disponibilidad actualizada/);
    }
  });
});
