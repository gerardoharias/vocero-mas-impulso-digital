import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCandidateSlots,
  filterFreeSlots,
} from "@/server/agenda/availability";
import { DEFAULT_CALENDAR_SETTINGS } from "@/server/agenda/settings";

/**
 * Incidente 2026-09-20. El agente ofreció lunes 21, martes 22 y miércoles 23,
 * los TRES a las 09:00. El cliente dijo "miércoles pero no puedo a las 9 am" y
 * recibió EXACTAMENTE los mismos tres horarios. Después insistió con "puedo
 * por las tardes después de las 6", el agente se inventó que "las
 * demostraciones las tenemos en horario de mañana" y escaló. Lead perdido.
 *
 * La causa era el contrato: `offer_slots` no tenía cómo decir "miércoles" y
 * `offerSlots` no tenía cómo filtrar. Aquí se fija el comportamiento nuevo.
 */

const MX = "America/Mexico_City";
/** Mié 5 de agosto de 2026, 08:00 hora de México. */
const NOW = new Date("2026-08-05T14:00:00.000Z");

// `vi.mock` se iza al principio del archivo, así que lo que usen sus fábricas
// tiene que existir antes: `vi.hoisted` es el único sitio seguro.
const mocks = vi.hoisted(() => ({
  computeAvailability: vi.fn(),
  replaceOffers: vi.fn(
    async (
      _org: string,
      _conv: string,
      _slots: { startUtc: string; label: string }[]
    ) => {}
  ),
  getOffers: vi.fn(async () => [] as { startUtc: string; label: string }[]),
}));
const { computeAvailability, replaceOffers, getOffers } = mocks;

const settings = {
  ...DEFAULT_CALENDAR_SETTINGS,
  timezone: MX,
  minNoticeHours: 0,
  maxDaysAhead: 7,
};

vi.mock("@/server/agenda/settings", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/agenda/settings")>();
  return {
    ...original,
    getSettings: async () => ({
      ...original.DEFAULT_CALENDAR_SETTINGS,
      timezone: "America/Mexico_City",
      minNoticeHours: 0,
      maxDaysAhead: 7,
    }),
  };
});
vi.mock("@/server/agenda/availability", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/agenda/availability")>();
  return { ...original, computeAvailability: mocks.computeAvailability };
});
vi.mock("@/server/agenda/offers", () => ({
  replaceOffers: mocks.replaceOffers,
  getOffers: mocks.getOffers,
}));
vi.mock("@/lib/env", () => ({ appBaseUrl: () => "https://crm.ejemplo.test" }));

/** Los huecos reales de un rango de días, como los daría el motor. */
function libres(fromISO: string, toISO: string) {
  return filterFreeSlots(buildCandidateSlots(settings, fromISO, toISO), [], {
    now: NOW,
    minNoticeHours: 0,
    timezone: MX,
  });
}

/** Las líneas de bullets del mensaje. */
function bullets(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("• "));
}

/** Solo las horas ("09:00"), para comparar ofertas entre sí. */
function horas(text: string): string[] {
  return bullets(text).map((l) => l.split(" a las ")[1] ?? "");
}

/** Lo que se registró como reservable en la última llamada. */
function registrado(): { startUtc: string; label: string }[] {
  return replaceOffers.mock.calls.at(-1)?.[2] ?? [];
}

describe("offerSlots — pedir OTRO DÍA deja de repetir lo mismo", () => {
  beforeEach(() => {
    computeAvailability.mockReset();
    replaceOffers.mockClear();
    getOffers.mockReset();
    getOffers.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("sin `day`, el menú sigue cubriendo VARIOS días", async () => {
    // El comportamiento que arregló un bug anterior y no se puede perder.
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.status).toBe("offered");
    const dias = new Set(bullets(turn.text).map((l) => l.split(" a las ")[0]));
    expect(dias.size).toBeGreaterThan(1);
  });

  it("EL INCIDENTE: con `day`, salen varias HORAS de ESE día", async () => {
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: "2026-08-06",
    });

    expect(turn.status).toBe("offered");
    const lineas = bullets(turn.text);
    expect(lineas.length).toBeGreaterThan(1);
    // Todas del mismo día…
    expect(new Set(lineas.map((l) => l.split(" a las ")[0])).size).toBe(1);
    // …con horas DISTINTAS…
    expect(new Set(horas(turn.text)).size).toBe(lineas.length);
    // …y alguna después del mediodía: el cliente dijo que por la mañana no.
    expect(horas(turn.text).some((h) => Number(h.slice(0, 2)) >= 12)).toBe(true);
  });

  it("no encabeza la lista con un horario que el cliente ACABA de descartar", async () => {
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    // La oferta vigente incluye el jueves 09:00, que es justo lo que rechazó.
    getOffers.mockResolvedValue([
      { startUtc: "2026-08-06T15:00:00.000Z", label: "jue 6 ago, 09:00" },
    ]);
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: "2026-08-06",
    });

    expect(horas(turn.text)[0]).not.toBe("09:00");
  });

  it("el catálogo registrado CONSERVA los otros días", async () => {
    // Si se reemplazara solo con el día pedido, un "mejor el martes que me
    // ofreciste" acabaría en slot_not_offered: cambiaríamos un bug de oferta
    // por uno de reserva.
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: "2026-08-06",
    });

    const dias = new Set(registrado().map((o) => o.startUtc.slice(0, 10)));
    expect(dias.size).toBeGreaterThan(1);
  });

  it("un `day` que no es una fecha se ignora: el cliente recibe opciones igual", async () => {
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    for (const basura of ["miércoles", "2026-13-45", ""]) {
      const turn = await offerSlots({
        organizationId: "org_1",
        conversationId: "cv_1",
        day: basura,
      });
      expect(turn.status).toBe("offered");
      expect(bullets(turn.text).length).toBeGreaterThan(0);
    }
  });
});

describe("offerSlots — cuando ese día no da nada, lo dice con la verdad", () => {
  beforeEach(() => {
    computeAvailability.mockReset();
    replaceOffers.mockClear();
    getOffers.mockReset();
    getOffers.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("un día SIN agenda ofrece la alternativa más cercana, y no escala", async () => {
    // Sábado 8: el horario por defecto es L-V, así que no abre.
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-10"));
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: "2026-08-08",
    });

    expect(turn.status).toBe("day_unavailable");
    expect(turn.ok).toBe(false);
    expect(bullets(turn.text).length).toBeGreaterThan(0);
  });

  it("un día fuera de la ventana lo explica en vez de adivinar", async () => {
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: "2027-01-15",
    });

    expect(turn.status).toBe("day_unavailable");
    expect(turn.text).toContain("Solo puedo agendar");
    expect(bullets(turn.text).length).toBeGreaterThan(0);
  });

  it("la intro optimista del modelo NO se pega cuando no hay nada que listar", async () => {
    // Bug latente: el modelo escribe "Claro, aquí tienes horarios:" dando por
    // hecho que habrá lista, y al prospecto le llegaba esa frase SOLA.
    computeAvailability.mockResolvedValue([]);
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "¡Claro! Aquí tienes algunos horarios disponibles:",
    });

    expect(turn.status).toBe("no_availability");
    expect(turn.text).not.toContain("Aquí tienes algunos horarios");
    expect(turn.text).toContain("no me quedan horarios libres");
  });
});
