/**
 * 025 (revisión correctiva) — La frontera entre lo que el MODELO dice que quiere
 * consultar y lo que el CLIENTE realmente pidió. Todo aquí es puro (sin BD, sin
 * red, sin reloj) y determinista.
 *
 * Por qué existe: el modo estricto de `response_format` obliga al proveedor a
 * rellenar TODAS las propiedades del sobre de la acción, y un modelo pequeño lo
 * hace con `""`, `[]` y hasta con un valor plausible del enum (`edge:"earliest"`),
 * y un perfil heredado que dice «usa offer_slots» compite con las reglas de la
 * agenda. Ninguna de las dos cosas debe cambiar lo que ve el prospecto:
 *
 *   1. `normalizeQueryFields`: `""`, espacios y `[]` son AUSENCIA, antes de validar
 *      o ejecutar (un `edge:""` ni siquiera pasaría el enum).
 *   2. `explicitEdge`: `edge` sólo vale si el cliente pidió el primer/último
 *      horario con esas palabras. «Más horarios», «qué horarios hay» y
 *      «disponibilidad mañana» NO son `earliest`.
 *   3. `extractTemporalQuery`: detecta un día, fecha, hora, rango o expresión
 *      temporal («la semana que viene») en el mensaje, conservando el texto original.
 *   4. `guardAgendaAction`: `offer_slots` se reserva para «dame opciones» sin
 *      ningún día/fecha/hora/rango; con alguno, la acción es `check_availability`.
 *
 * Los textos que se comparan son los del CLIENTE. Nada de lo que devuelve el modelo
 * se usa para decidir sobre sí mismo.
 */

export type EdgeValue = "earliest" | "latest";

export type QueryFields = {
  day?: string;
  /** 026 — días alternativos ("jueves o viernes"). Mutuamente excluyente con `day`. */
  days?: string[];
  times?: string[];
  from?: string;
  to?: string;
  edge?: EdgeValue;
};

const str = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
};

/** Tope defensivo de `days[]` ANTES de que `availability-query.ts` decida "demasiados" (regla del dueño: máx 3). */
const DAYS_ARRAY_HARD_CAP = 10;

/**
 * `""`, espacios, `null`, `[]`, `[""]` y un `edge` que no es de los dos valores
 * ⇒ AUSENTE. Lo demás se conserva (recortado). Acepta un texto suelto en
 * `times`/`days`. `day` y `days` son mutuamente excluyentes: si `days` trae
 * algo, `day` se descarta (026 §3.2 — el servidor no le pregunta al modelo
 * por un descuido de formato, mismo criterio que 025 §11.4).
 */
export function normalizeQueryFields(raw: Record<string, unknown> | null | undefined): QueryFields {
  const r = raw ?? {};
  const out: QueryFields = {};
  const day = str(r.day);
  if (day) out.day = day;
  const list = Array.isArray(r.times) ? r.times : r.times === undefined || r.times === null ? [] : [r.times];
  const times = list.map(str).filter((t): t is string => t !== undefined);
  if (times.length > 0) out.times = times;
  const dayList = Array.isArray(r.days) ? r.days : r.days === undefined || r.days === null ? [] : [r.days];
  const daysArr = dayList
    .map(str)
    .filter((t): t is string => t !== undefined)
    .slice(0, DAYS_ARRAY_HARD_CAP);
  if (daysArr.length > 0) {
    out.days = daysArr;
    delete out.day;
  }
  const from = str(r.from);
  if (from) out.from = from;
  const to = str(r.to);
  if (to) out.to = to;
  const edge = str(r.edge)?.toLowerCase();
  if (edge === "earliest" || edge === "latest") out.edge = edge;
  return out;
}

/**
 * Normaliza la acción `check_availability` cruda que devolvió el modelo (antes de
 * Zod). Cualquier otra acción pasa intacta.
 */
export function normalizeAgentActionInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  if (o.action !== "check_availability") return raw;
  return { action: "check_availability", ...normalizeQueryFields(o) };
}

// ---------------------------------------------------------------------------
// Texto del cliente
// ---------------------------------------------------------------------------

const plain = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** No es una fecha: «el primero de octubre», «el último de mes». */
const NOT_A_DATE = String.raw`(?!\s+de\s+[a-z])`;

const EARLIEST_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?:lo\s+|el\s+)?mas\s+(?:temprano|pronto)(?:\s+posible)?` +
    String.raw`|lo\s+antes\s+posible` +
    String.raw`|primer(?:o|a)?\s+(?:horario|hueco|espacio|lugar|opcion|disponible|cita)` +
    String.raw`|(?:el|lo)\s+primer(?:o|a)?\b${NOT_A_DATE}` +
    String.raw`)\b`
);
const LATEST_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?:lo\s+|el\s+)?mas\s+tarde(?:\s+posible)?` +
    String.raw`|ultim(?:o|a)\s+(?:horario|hueco|espacio|lugar|opcion|disponible|cita)` +
    String.raw`|(?:el|lo)\s+ultim(?:o|a)\b${NOT_A_DATE}` +
    String.raw`)\b`
);

/**
 * `earliest`/`latest` sólo si el cliente lo pidió con esas palabras («el primer
 * horario», «el más temprano», «el último», «el más tarde»). Si aparecen las dos
 * o ninguna: `null`.
 */
export function explicitEdge(customerText: string): EdgeValue | null {
  const t = plain(customerText);
  const early = EARLIEST_RE.test(t);
  const late = LATEST_RE.test(t);
  if (early === late) return null;
  return early ? "earliest" : "latest";
}

const MONTHS = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
const WEEKDAYS = "lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo";
const SUFFIX = String.raw`(?:a\.?\s?m\.?|p\.?\s?m\.?|de\s+la\s+(?:ma[nñ]ana|tarde|noche)|hrs?)`;
const HOUR = String.raw`\d{1,2}(?::\d{2})?`;

const ISO_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const DATE_RE = new RegExp(String.raw`\b(?:el\s+)?\d{1,2}\s+de\s+(?:${MONTHS})\b`, "i");
const WEEKDAY_RE = new RegExp(String.raw`\b(?:(?:el|este|pr[oó]ximo)\s+)?(?:${WEEKDAYS})\b`, "i");
const DAY_WORD_RE = /\b(?:pasado\s+ma[nñ]ana|hoy)\b/i;
/** «mañana» = el día siguiente, NO «la mañana» / «por la mañana» / «esta mañana» / «de mañana». */
const TOMORROW_RE = /(?<!\b(?:la|esta|de|por|en|una)\s)\bma[nñ]ana\b/i;
/** Expresiones de semana/mes que el servidor NO resuelve: viajan con las palabras del cliente. */
const PERIOD_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?:la\s+|esta\s+|toda\s+la\s+|otra\s+)?semana\s+(?:que\s+viene|pr[oó]xima|siguiente|entrante)` +
    String.raw`|(?:la\s+)?pr[oó]xima\s+semana|esta\s+semana|la\s+otra\s+semana` +
    String.raw`|(?:este\s+|el\s+)?fin\s+de\s+semana|(?:el\s+)?finde` +
    String.raw`|(?:el\s+)?(?:pr[oó]ximo\s+mes|mes\s+que\s+viene|mes\s+pr[oó]ximo)` +
    String.raw`|en\s+(?:\d+|una|dos|tres|cuatro)\s+semanas?` +
    String.raw`|(?:a\s+)?(?:mediados|finales|principios)\s+de\s+(?:mes|semana|(?:${MONTHS}))` +
    String.raw`)\b`,
  "i"
);

const RANGE_RE = new RegExp(
  String.raw`\b(?:entre|de)\s+las?\s+(${HOUR}(?:\s?${SUFFIX})?)\s+(?:y|a)\s+(?:las?\s+)?(${HOUR}(?:\s?${SUFFIX})?)`,
  "i"
);
const AFTER_RE = new RegExp(String.raw`\bdespu[eé]s\s+de\s+las?\s+(${HOUR}(?:\s?${SUFFIX})?)`, "i");
const BEFORE_RE = new RegExp(String.raw`\bantes\s+de\s+las?\s+(${HOUR}(?:\s?${SUFFIX})?)`, "i");
const AT_RE = new RegExp(
  String.raw`\ba\s+las?\s+(?<h1>${HOUR}|una)(?<x1>\s+y\s+(?:media|cuarto)|\s+menos\s+cuarto)?(?:\s?(?<s1>${SUFFIX}))?` +
    String.raw`(?:\s+(?:o|u|y)\s+(?:a\s+las?\s+)?(?<h2>${HOUR})(?<x2>\s+y\s+(?:media|cuarto)|\s+menos\s+cuarto)?(?:\s?(?<s2>${SUFFIX}))?)?`,
  "i"
);
const BARE_AMPM_RE = new RegExp(String.raw`\b(${HOUR}\s?(?:a\.?\s?m\.?|p\.?\s?m\.?))(?![a-z])`, "i");
const NOON_RE = /\b(?:al\s+)?medio\s?d[ií]a\b/i;

export type TemporalQuery = QueryFields & {
  /** Hay un día, fecha, hora, rango o expresión temporal en el mensaje. */
  hasTemporal: boolean;
};

/**
 * Lo temporal que dijo el cliente, con SUS palabras. Sólo reconoce formas claras:
 * un falso negativo deja que decida el modelo; un falso positivo sólo haría que el
 * servidor consulte/aclare, nunca que afirme nada. No decide si algo está libre.
 */
export function extractTemporalQuery(customerText: string): TemporalQuery {
  const text = customerText.replace(/\s+/g, " ").trim();
  const out: TemporalQuery = { hasTemporal: false };
  if (text === "") return out;

  // Día / fecha / semana: la primera expresión que aparezca en el mensaje.
  const dayHits: { index: number; text: string }[] = [];
  for (const re of [ISO_RE, DATE_RE, WEEKDAY_RE, DAY_WORD_RE, TOMORROW_RE, PERIOD_RE]) {
    const m = re.exec(text);
    if (m) dayHits.push({ index: m.index, text: m[0].trim() });
  }
  dayHits.sort((a, b) => a.index - b.index);
  if (dayHits[0]) out.day = dayHits[0].text;

  // Hora(s) concretas o rango.
  const at = AT_RE.exec(text);
  const range = RANGE_RE.exec(text);
  if (range) {
    out.from = range[1]!.trim();
    out.to = range[2]!.trim();
  } else if (at?.groups) {
    const g = at.groups as Record<string, string | undefined>;
    const hour = (h: string | undefined) => (h && /^una$/i.test(h) ? "1" : h);
    const s1 = g.s1 ?? g.s2;
    const s2 = g.s2 ?? g.s1;
    const t1 = `${hour(g.h1)}${g.x1 ?? ""}${s1 ? ` ${s1}` : ""}`.trim();
    const times = [t1];
    if (g.h2) times.push(`${g.h2}${g.x2 ?? ""}${s2 ? ` ${s2}` : ""}`.trim());
    out.times = times;
  } else {
    const after = AFTER_RE.exec(text);
    const before = BEFORE_RE.exec(text);
    if (after) out.from = after[1]!.trim();
    if (before) out.to = before[1]!.trim();
    if (!after && !before) {
      const bare = BARE_AMPM_RE.exec(text);
      if (bare) out.times = [bare[1]!.trim()];
      else if (NOON_RE.test(text)) out.times = ["mediodía"];
    }
  }

  const edge = explicitEdge(text);
  if (edge) out.edge = edge;

  out.hasTemporal = Boolean(out.day || out.times || out.from || out.to);
  return out;
}

// ---------------------------------------------------------------------------
// La compuerta
// ---------------------------------------------------------------------------

export type GuardableAction =
  | { action: "offer_slots"; reply?: string }
  | ({ action: "check_availability" } & QueryFields)
  | { action: string; [k: string]: unknown };

export type GuardResult<A> = {
  action: A;
  /** Códigos sin texto libre (aptos para logs): qué se cambió y por qué. */
  changes: ("empty_fields_dropped" | "edge_removed" | "rerouted_offer_slots_to_check_availability")[];
};

/**
 * Compuerta previa a ejecutar una acción de agenda, con el texto que el CLIENTE
 * escribió en este turno:
 *
 *   - `check_availability`: vacíos ⇒ ausencia; `edge` sólo si lo pidió con esas
 *     palabras (si no, se quita: «más horarios mañana» lista el día completo).
 *   - `offer_slots` + una expresión temporal ⇒ `check_availability` con sus palabras
 *     (aunque el servidor no la entienda: es él quien pide la aclaración). Las
 *     instrucciones del negocio que digan «usa offer_slots» no cambian esto.
 *
 * Nunca toca `book_slot` (aceptar un horario ofrecido menciona día y hora a propósito).
 */
export function guardAgendaAction<A extends { action: string }>(action: A, customerText: string): GuardResult<A> {
  const changes: GuardResult<A>["changes"] = [];

  if (action.action === "check_availability") {
    const raw = action as unknown as Record<string, unknown>;
    const normalized = normalizeQueryFields(raw);
    const hadEmpty = Object.keys(raw).some((k) => k !== "action" && !(k in normalized) && raw[k] !== undefined);
    if (hadEmpty) changes.push("empty_fields_dropped");
    if (normalized.edge && explicitEdge(customerText) !== normalized.edge) {
      delete normalized.edge;
      changes.push("edge_removed");
    }
    return { action: { action: "check_availability", ...normalized } as unknown as A, changes };
  }

  if (action.action === "offer_slots") {
    const q = extractTemporalQuery(customerText);
    if (q.hasTemporal) {
      const { hasTemporal: _has, ...fields } = q;
      void _has;
      changes.push("rerouted_offer_slots_to_check_availability");
      return { action: { action: "check_availability", ...fields } as unknown as A, changes };
    }
  }
  return { action, changes };
}
