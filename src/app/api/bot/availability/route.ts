import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { scoped } from "@/lib/db/tenant";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { queryAvailability } from "@/server/agenda/availability-query";
import { dayIsoInTz, dayLabelInTz, timeInTz } from "@/lib/time/slots";
import { replaceOffers } from "@/server/agenda/offers";

export const dynamic = "force-dynamic";

/**
 * 015 — Los horarios que se le van a ofrecer al cliente, para quien conduce la
 * conversación.
 *
 * A diferencia de la vista del operador, esta REGISTRA la oferta: es ese
 * registro lo que después habilita la reserva. Sin él, `POST /api/bot/bookings`
 * rechaza cualquier instante.
 *
 * El catálogo reservable (`limit`) es más ancho que el menú que el agente
 * enseña: guardar solo los tres que se muestran deja al agente sin nada
 * legítimo que aceptar cuando el cliente pide otro día.
 */

const LIMITS = {
  limit: { min: 1, max: 48, def: 12 },
  perDay: { min: 1, max: 8, def: 3 },
  days: { min: 1, max: 14, def: 5 },
};

function clamp(raw: string | null, l: { min: number; max: number; def: number }) {
  // 025: sin parámetro es el valor POR DEFECTO. Antes `Number(null)` daba 0 (finito)
  // y `Math.max(min, …)` devolvía el MÍNIMO: una llamada sin parámetros traía 1
  // hueco y 1 día, y declaraba que el resto de los días no tenían agenda.
  if (raw === null || raw.trim() === "") return l.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return l.def;
  return Math.max(l.min, Math.min(l.max, Math.round(n)));
}

export async function GET(req: Request) {
  // La bandera se evalúa ANTES que la llave: si esta instancia no tiene
  // agenda, el endpoint no existe — no hay nada que autenticar.
  if (!agendaEnabled()) return agendaDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return apiError(422, "invalid_body", "Falta conversationId");
  }

  const db = getDb();
  const rows = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Conversación no encontrada");

  const limit = clamp(url.searchParams.get("limit"), LIMITS.limit);
  const perDay = clamp(url.searchParams.get("perDay"), LIMITS.perDay);
  const days = clamp(url.searchParams.get("days"), LIMITS.days);
  const dayParam = url.searchParams.get("day")?.trim() || undefined;
  // 026 — días alternativos: "altDays=jueves,viernes" (coma). NO se llama
  // "days": ese nombre ya lo tiene la VENTANA numérica de días de la lista
  // truncada (arriba, `LIMITS.days`) desde 015 — reusarlo habría chocado con
  // ese contrato ya publicado. Tope real lo aplica `answerQuery` (MAX_QUERY_DAYS).
  const altDaysParam = url.searchParams
    .get("altDays")
    ?.split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  const fromParam = url.searchParams.get("from")?.trim() || undefined;
  const toParam = url.searchParams.get("to")?.trim() || undefined;

  const settings = await getSettings(organizationId);
  const now = new Date();
  const tz = settings.timezone;

  // La verdad completa del horizonte: de aquí salen los metadatos y los días con agenda.
  const all = await computeAvailability(organizationId, { settings, now });
  const daysOf = (slots: typeof all) => [
    ...new Set(slots.map((s) => dayIsoInTz(new Date(s.startUtc), tz))),
  ];
  // `diasConAgenda` conserva el sentido del contrato publicado (015): los días CON
  // agenda dentro de la ventana `days` que se pidió — pero COMPLETO, no el de la lista
  // truncada por `limit`/`perDay`. Los del horizonte entero van aparte (aditivo).
  const diasConAgenda = daysOf(
    all.filter((s) => withinDays(dayIsoInTz(new Date(s.startUtc), tz), days, tz, now))
  );
  const diasConAgendaHorizonte = daysOf(all);

  const toSlotDto = (s: {
    startUtc: string;
    endUtc: string;
    label: string;
  }) => {
    const dayIso = dayIsoInTz(new Date(s.startUtc), tz);
    return {
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      label: s.label,
      dayIso,
      dayLabel: dayLabelInTz(s.startUtc, tz, now),
      time: timeInTz(s.startUtc, tz),
    };
  };

  // 025/026 — CONSULTA DIRECTA (`day`/`altDays`, `from`, `to`): la disponibilidad
  // COMPLETA de lo pedido, con las mismas reglas que el agente integrado
  // (`check_availability`).
  if (dayParam || (altDaysParam && altDaysParam.length > 0) || fromParam || toParam) {
    const answer = await queryAvailability({
      organizationId,
      query: { day: dayParam, days: altDaysParam, from: fromParam, to: toParam },
      settings,
      now,
    });
    if (answer.status === "availability_clarify") {
      return apiError(422, "invalid_query", answer.text);
    }
    // Reemplazo completo, `active` (el cerebro externo muestra la lista por su cuenta).
    if (answer.offers.length > 0) {
      await replaceOffers(
        organizationId,
        conversationId,
        answer.offers.map((o) => ({ startUtc: o.startUtc, label: o.label }))
      );
    }
    return Response.json({
      slots: answer.matches.slice(0, LIMITS.limit.max).map(toSlotDto),
      diasConAgenda,
      diasConAgendaHorizonte,
      exhaustive: answer.meta.exhaustive && answer.matches.length <= LIMITS.limit.max,
      hasMore: answer.meta.hasMore || answer.matches.length > LIMITS.limit.max,
      total: answer.meta.total,
      scopeComplete: answer.meta.scopeComplete,
      horizonDays: settings.maxDaysAhead,
      kind: answer.meta.kind,
      // El texto que el agente integrado le mandaría: sirve de referencia exacta.
      resumen: answer.text,
    });
  }

  const spread = spreadByDay(all, {
    timezone: tz,
    limit,
    perDay,
    now,
  }).filter((s) => withinDays(s.dayIso, days, tz, now));

  // Cuántos horarios libres hay en la ventana `days` (la verdad contra la que se
  // compara lo devuelto): si `total > slots.length`, la lista es PARCIAL.
  const totalInWindow = all.filter((s) =>
    withinDays(dayIsoInTz(new Date(s.startUtc), tz), days, tz, now)
  ).length;

  // Reemplazo completo: la oferta vigente es siempre la última.
  await replaceOffers(
    organizationId,
    conversationId,
    spread.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  return Response.json({
    slots: spread.map((s) => ({
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      label: s.label,
      dayIso: s.dayIso,
      dayLabel: s.dayLabel,
      time: s.time,
    })),
    // 025: completo dentro de la ventana `days` (antes salía de la lista truncada, y
    // el contrato prometía que «los días ausentes NO tienen agenda»). El horizonte
    // entero, aparte, en `diasConAgendaHorizonte`.
    diasConAgenda,
    diasConAgendaHorizonte,
    // Lista PARCIAL vs completa: nunca afirmes «no hay» si `hasMore` es true.
    exhaustive: totalInWindow <= spread.length,
    hasMore: totalInWindow > spread.length,
    total: totalInWindow,
    scopeComplete: true,
    horizonDays: settings.maxDaysAhead,
    kind: "suggestions",
  });
}

function withinDays(
  dayIso: string,
  days: number,
  timezone: string,
  now: Date
): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const diff =
    (Date.parse(`${dayIso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
    86_400_000;
  return diff >= 0 && diff < days;
}
