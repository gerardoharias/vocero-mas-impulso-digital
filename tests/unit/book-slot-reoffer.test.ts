import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 024 §5.7 — la re-oferta de `bookSlot` es un mensaje con horarios, igual
 * que `offer_slots`: no registra nada como `active` por su cuenta y entrega el
 * catálogo con `shown` para que `sendText` lo persista `pending` con el mensaje.
 */

const createSessionBooking = vi.fn();
vi.mock("@/server/agenda/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/service")>();
  return { ...original, createSessionBooking, findActiveBooking: vi.fn() };
});
vi.mock("@/server/agenda/reschedule-requests", () => ({ requestReschedule: vi.fn() }));
vi.mock("@/lib/env", () => ({ appBaseUrl: () => "https://crm.ejemplo.test" }));
const replaceOffers = vi.fn();
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, replaceOffers };
});

const slot = (i: number) => ({
  startUtc: `2026-09-2${i}T15:00:00.000Z`,
  label: `lun 2${i} sep, 09:00`,
});

beforeEach(() => {
  createSessionBooking.mockReset();
  replaceOffers.mockReset();
});

describe("bookSlot: re-oferta", () => {
  it("le pide al servicio NO registrar las alternativas (registerAlternatives:false)", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const { BookingError } = await import("@/server/agenda/service");
    createSessionBooking.mockRejectedValue(new BookingError("slot_taken", "ocupado", [slot(1)]));
    await bookSlot({ organizationId: "org_1", conversationId: "cv_1", startUtc: slot(9).startUtc });
    expect(createSessionBooking).toHaveBeenCalledWith(
      expect.objectContaining({ registerAlternatives: false, requireOffer: true })
    );
    expect(replaceOffers).not.toHaveBeenCalled(); // este módulo jamás escribe ofertas
  });

  it("slot_taken: el texto muestra las 3 primeras y `offers` lleva TODAS con `shown` sólo en esas 3", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const { BookingError } = await import("@/server/agenda/service");
    const alts = [slot(1), slot(2), slot(3), slot(4), slot(5)];
    createSessionBooking.mockRejectedValue(new BookingError("slot_taken", "ocupado", alts));

    const turn = await bookSlot({ organizationId: "org_1", conversationId: "cv_1", startUtc: slot(9).startUtc });

    expect(turn.status).toBe("slot_taken");
    expect(turn.ok).toBe(false);
    expect(turn.text).toBe(
      ["Se me acaba de ocupar ese horario, ¡perdón!", "• lun 21 sep, 09:00", "• lun 22 sep, 09:00", "• lun 23 sep, 09:00"].join("\n")
    );
    expect(turn.offers).toHaveLength(5);
    expect(turn.offers!.map((o) => o.shown)).toEqual([true, true, true, false, false]);
    expect(turn.offers!.map((o) => o.startUtc)).toEqual(alts.map((a) => a.startUtc));
  });

  it("slot_not_offered usa el mismo contrato (mensaje + horarios con `shown`)", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const { BookingError } = await import("@/server/agenda/service");
    createSessionBooking.mockRejectedValue(new BookingError("slot_not_offered", "no ofrecido", [slot(1), slot(2)]));
    const turn = await bookSlot({ organizationId: "org_1", conversationId: "cv_1", startUtc: slot(9).startUtc });
    expect(turn.status).toBe("not_offered");
    expect(turn.text).toMatch(/^Déjame confirmarte los horarios que tengo:/);
    expect(turn.offers!.map((o) => o.shown)).toEqual([true, true]);
  });

  it("sin alternativas no hay oferta que persistir (mensaje de error genérico, sin `offers`)", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const { BookingError } = await import("@/server/agenda/service");
    createSessionBooking.mockRejectedValue(new BookingError("slot_taken", "ocupado", []));
    const turn = await bookSlot({ organizationId: "org_1", conversationId: "cv_1", startUtc: slot(9).startUtc });
    expect(turn.status).toBe("error");
    expect(turn.offers).toBeUndefined();
  });

  it("una reserva exitosa no lleva `offers` (no es una oferta)", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    createSessionBooking.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: false,
      label: "lun 21 sep, 09:00",
    });
    const turn = await bookSlot({ organizationId: "org_1", conversationId: "cv_1", startUtc: slot(1).startUtc });
    expect(turn.status).toBe("booked");
    expect(turn.offers).toBeUndefined();
  });
});
