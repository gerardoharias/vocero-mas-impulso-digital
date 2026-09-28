import { dayIsoInTz } from "@/lib/time/slots";

/**
 * 025 — Las N alternativas más CERCANAS a un horario pedido.
 *
 * Antes, cuando el horario elegido se ocupaba, las alternativas eran «las 3
 * primeras del horizonte» (la mañana de HOY aunque el prospecto hubiera pedido el
 * lunes a las 4). Aquí: el mismo día primero, por cercanía de hora; luego los
 * días siguientes/anteriores por cercanía de día y de hora. El resultado sale en
 * orden cronológico (así se le muestra al prospecto).
 *
 * PURA: no lee la base ni el reloj; el motor de disponibilidad ya filtró lo que
 * está libre. El objetivo mismo se excluye.
 */
export function nearestSlots<T extends { startUtc: string }>(
  free: T[],
  targetUtc: string,
  timezone: string,
  n: number
): T[] {
  const target = Date.parse(targetUtc);
  if (Number.isNaN(target) || n <= 0) return free.slice(0, Math.max(0, n));

  const targetDay = Date.parse(`${dayIsoInTz(new Date(target), timezone)}T00:00:00Z`);

  const scored = free
    .filter((s) => Date.parse(s.startUtc) !== target)
    .map((s) => {
      const t = Date.parse(s.startUtc);
      const day = Date.parse(`${dayIsoInTz(new Date(t), timezone)}T00:00:00Z`);
      const dayDistance = Math.abs(day - targetDay) / 86_400_000;
      // Cercanía dentro del día: minutos entre las horas de pared.
      const minuteDistance =
        dayDistance === 0
          ? Math.abs(t - target) / 60_000
          : Math.abs(wallMinutes(t, timezone) - wallMinutes(target, timezone));
      return { s, t, dayDistance, minuteDistance };
    })
    .sort(
      (a, b) =>
        a.dayDistance - b.dayDistance || a.minuteDistance - b.minuteDistance || a.t - b.t
    );

  return scored
    .slice(0, n)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.s);
}

function wallMinutes(epochMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
