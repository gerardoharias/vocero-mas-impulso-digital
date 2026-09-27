import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildCandidateSlots,
  filterFreeSlots,
} from "@/server/agenda/availability";
import { DEFAULT_CALENDAR_SETTINGS } from "@/server/agenda/settings";

/**
 * Lo que queda del incidente 2026-09-20 ("el miércoles pero no a las 9", y el
 * agente repitió los mismos tres horarios).
 *
 * Aquel arreglo vivía en un `day` opcional de `offer_slots`. Las specs 025/026
 * lo sustituyeron por `check_availability` + `availability-query`, que en vez
 * de fiarse de que el modelo calcule la fecha parsea las PALABRAS del cliente.
 * Esa parte se prueba ahora en `availability-query.test.ts`,
 * `check-availability-action.test.ts` y `query-intent.test.ts`.
 *
 * Aquí sobrevive lo que sigue siendo responsabilidad de `offerSlots`, y que
 * ningún test de upstream cubre.
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
const { computeAvailability, getOffers } = mocks;

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

describe("offerSlots — el menú genérico", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOffers.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("el menú cubre VARIOS días, no llena el cupo con el primero", async () => {
    // Un negocio reportó "dijo que había jueves, viernes y lunes, pero solo
    // mostró miércoles": con `perDay` huecos o más en el primer día, un
    // `.slice(0, 3)` se los comía todos.
    computeAvailability.mockResolvedValue(libres("2026-08-05", "2026-08-07"));
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.status).toBe("offered");
    const dias = new Set(bullets(turn.text).map((l) => l.split(" a las ")[0]));
    expect(dias.size).toBeGreaterThan(1);
  });

  it("la intro optimista del modelo NO se pega cuando no hay nada que listar", async () => {
    // El modelo escribe "Claro, aquí tienes horarios:" dando por hecho que
    // habrá lista, y al prospecto le llegaba esa frase SOLA. La versión de
    // upstream volvía a pegarla: este test es lo que lo impide.
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
