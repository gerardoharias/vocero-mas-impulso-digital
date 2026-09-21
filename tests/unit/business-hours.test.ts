import { describe, expect, it } from "vitest";
import { renderWeeklyHours } from "@/server/agenda/hours";
import { DEFAULT_CALENDAR_SETTINGS } from "@/server/agenda/settings";

/**
 * El horario de atención viaja al system prompt y el modelo lo REPITE tal cual
 * cuando el prospecto pregunta "¿hasta qué hora atienden?". Si ahí dice
 * "18:00" mientras las ofertas dicen "6:00 pm", la misma conversación usa dos
 * relojes distintos.
 */
describe("renderWeeklyHours — el horario que lee el prospecto", () => {
  const now = new Date("2026-09-20T18:00:00.000Z");

  it("agrupa la semana y la escribe en 12 h", () => {
    const hours = renderWeeklyHours(DEFAULT_CALENDAR_SETTINGS, now);
    expect(hours.lines).toEqual(["Lunes a viernes: 9:00 am–6:00 pm"]);
    expect(hours.closed).toBe("sábado y domingo");
  });

  it("una franja partida conserva sus dos tramos", () => {
    const hours = renderWeeklyHours(
      {
        ...DEFAULT_CALENDAR_SETTINGS,
        weeklyHours: {
          sat: [
            { start: "09:00", end: "13:00" },
            { start: "15:30", end: "20:00" },
          ],
        },
      },
      now
    );
    expect(hours.lines).toEqual(["Sábado: 9:00 am–1:00 pm, 3:30 pm–8:00 pm"]);
  });
});
