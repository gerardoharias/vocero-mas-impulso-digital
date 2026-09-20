import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Incidente 2026-09-19 — el dueño canceló una cita desde la pantalla de Citas.
 * El prospecto había pedido antes MOVERLA, así que había una solicitud de
 * cambio `pending`. Cancelar no la tocaba, y una solicitud pendiente hace que
 * `createSessionBooking` lance `reschedule_pending`: el agente quedaba
 * incapaz de volver a agendarle nada a ese contacto, por una cita que ya no
 * existía.
 *
 * Cancelar la cita SÍ atiende el pedido de moverla: no queda nada que mover.
 */

const resolvePendingRescheduleRequests = vi.fn(async () => {});
vi.mock("@/server/agenda/reschedule-requests", () => ({
  resolvePendingRescheduleRequests,
  getPendingRescheduleRequest: async () => null,
  requestReschedule: async () => ({}),
}));

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({
    weeklyHours: {},
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 7,
    timezone: "America/Mexico_City",
    connector: "enlace-fijo" as const,
    meetingLink: null,
  }),
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({ id: "enlace-fijo", deleteMeeting: async () => {} }),
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true }),
}));
const publish = vi.fn();
vi.mock("@/server/events/bus", () => ({ publish }));

const selectRows: unknown[][] = [];
const updates: Record<string, unknown>[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin"]) c[m] = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => chain(selectRows.shift() ?? []),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return {
          where: () => ({
            returning: () => Promise.resolve([v]),
            then: (resolve: (x: unknown) => void) =>
              Promise.resolve([v]).then(resolve),
          }),
        };
      },
    }),
  }),
  schema: {
    booking: { id: "id", organizationId: "organizationId" },
    conversation: {},
    contact: {},
    lead: {},
    pipelineStage: {},
    offeredSlot: {},
    bookingChangeRequest: {},
  },
}));

const CITA = {
  id: "bk_1",
  organizationId: "org_1",
  contactId: "ct_1",
  status: "agendada",
  kind: "session",
  isTest: false,
  externalRef: null,
  connector: "enlace-fijo",
  scheduledAt: new Date("2026-09-21T15:00:00.000Z"),
};

describe("cancelBooking — la solicitud de cambio deja de quedar huérfana", () => {
  beforeEach(() => {
    resolvePendingRescheduleRequests.mockClear();
    resolvePendingRescheduleRequests.mockResolvedValue(undefined);
    publish.mockClear();
    selectRows.length = 0;
    updates.length = 0;
  });

  it("cancelar resuelve el cambio pendiente del contacto", async () => {
    selectRows.push([CITA]);

    const { cancelBooking } = await import("@/server/agenda/service");
    await cancelBooking({ organizationId: "org_1", bookingId: "bk_1" });

    expect(updates[0]?.status).toBe("cancelada");
    expect(resolvePendingRescheduleRequests).toHaveBeenCalledTimes(1);
    expect(resolvePendingRescheduleRequests).toHaveBeenCalledWith("org_1", "ct_1");
  });

  it("cancelar una cita YA cancelada no resuelve nada (idempotencia)", async () => {
    // Importante: solo puede haber UNA solicitud pendiente por contacto, así
    // que resolver aquí podría matar el pedido de otra cita viva.
    selectRows.push([{ ...CITA, status: "cancelada" }]);

    const { cancelBooking } = await import("@/server/agenda/service");
    await cancelBooking({ organizationId: "org_1", bookingId: "bk_1" });

    expect(updates).toHaveLength(0);
    expect(resolvePendingRescheduleRequests).not.toHaveBeenCalled();
  });

  it("un bloqueo de agenda no tiene contacto: no revienta", async () => {
    selectRows.push([{ ...CITA, kind: "block", contactId: null }]);

    const { cancelBooking } = await import("@/server/agenda/service");
    await expect(
      cancelBooking({ organizationId: "org_1", bookingId: "bk_1" })
    ).resolves.toBeUndefined();

    expect(updates[0]?.status).toBe("cancelada");
    expect(resolvePendingRescheduleRequests).not.toHaveBeenCalled();
  });

  it("si resolver el pendiente falla, la cita queda cancelada igual", async () => {
    // Cancelar jamás puede fallar porque una tabla secundaria dio problema.
    resolvePendingRescheduleRequests.mockRejectedValue(new Error("boom"));
    selectRows.push([CITA]);

    const { cancelBooking } = await import("@/server/agenda/service");
    await expect(
      cancelBooking({ organizationId: "org_1", bookingId: "bk_1" })
    ).resolves.toBeUndefined();

    expect(updates[0]?.status).toBe("cancelada");
    expect(publish).toHaveBeenCalled();
  });
});
