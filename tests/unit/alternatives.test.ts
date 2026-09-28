import { describe, expect, it } from "vitest";
import { nearestSlots } from "@/server/agenda/alternatives";

/**
 * Spec 025 §5.2 — las alternativas tras un `slot_taken` son las más CERCANAS a
 * lo pedido (mismo día primero), no las primeras del horizonte.
 */

const TZ = "America/Mexico_City"; // UTC-6
const slot = (day: number, hourLocal: number, min = 0) => ({
  startUtc: new Date(Date.UTC(2026, 8, day, hourLocal + 6, min)).toISOString(),
});

describe("nearestSlots", () => {
  const all = [
    slot(17, 14), slot(17, 15),                    // hoy por la tarde (jueves)
    slot(21, 9), slot(21, 15), slot(21, 15, 30), slot(21, 16, 30), slot(21, 17),
    slot(22, 16), slot(23, 9),
  ];

  it("prefiere el MISMO día, por cercanía de hora", () => {
    const target = slot(21, 16).startUtc; // lunes 16:00 (ocupado)
    const out = nearestSlots(all, target, TZ, 3);
    // 15:30 y 16:30 (30 min); el desempate a 60 min lo gana la más temprana (15:00).
    expect(out).toEqual([slot(21, 15), slot(21, 15, 30), slot(21, 16, 30)]);
  });

  it("devuelve en orden CRONOLÓGICO aunque la cercanía sea otra", () => {
    const out = nearestSlots(all, slot(21, 16).startUtc, TZ, 2);
    // Las dos más cercanas son 15:30 y 16:30 (30 min): salen 15:30 → 16:30.
    expect(out).toEqual([slot(21, 15, 30), slot(21, 16, 30)]);
  });

  it("excluye el horario pedido", () => {
    const out = nearestSlots(all, slot(21, 15).startUtc, TZ, 10);
    expect(out.some((s) => s.startUtc === slot(21, 15).startUtc)).toBe(false);
  });

  it("si el mismo día no alcanza, completa con el día más cercano y hora parecida", () => {
    const few = [slot(21, 15, 30), slot(22, 16), slot(23, 9), slot(17, 14)];
    const out = nearestSlots(few, slot(21, 16).startUtc, TZ, 3);
    // 15:30 del lunes; luego el martes 16:00 (día +1, misma hora) y el miércoles 09:00 (día +2)…
    expect(out).toEqual([slot(21, 15, 30), slot(22, 16), slot(23, 9)]);
    // …y NO el jueves 14:00 (4 días antes) mientras haya opciones más cercanas.
    expect(out).not.toContainEqual(slot(17, 14));
  });

  it("agenda sin nada cerca: devuelve lo que haya, sin inventar", () => {
    expect(nearestSlots([], slot(21, 16).startUtc, TZ, 3)).toEqual([]);
    expect(nearestSlots([slot(23, 9)], slot(21, 16).startUtc, TZ, 3)).toEqual([slot(23, 9)]);
  });

  it("respeta la zona horaria al decidir qué es «el mismo día»", () => {
    // 23:30 hora de México del lunes = 05:30Z del martes: sigue siendo LUNES para el negocio.
    const late = { startUtc: "2026-09-22T05:30:00.000Z" };
    const nextMorning = { startUtc: "2026-09-22T15:00:00.000Z" }; // martes 09:00 local
    const target = "2026-09-22T04:00:00.000Z"; // lunes 22:00 local
    const out = nearestSlots([nextMorning, late], target, TZ, 1);
    expect(out).toEqual([late]);
  });

  it("objetivo inválido o n <= 0 no revienta", () => {
    expect(nearestSlots(all, "no-es-fecha", TZ, 2)).toHaveLength(2);
    expect(nearestSlots(all, slot(21, 16).startUtc, TZ, 0)).toEqual([]);
  });
});
