import { AGENDA_PRIORITY_MARKER, JUDGE_MARKER } from "@/server/ai/prompts";
import { extractTemporalQuery } from "@/server/agenda/query-intent";
import { RECOVERY_MARKER } from "@/server/ai/recovery";

/**
 * Proveedor LLM determinista para el self-test (contrato mocks.md).
 * Despacha por contenido del último mensaje `user` (o del system si es el
 * juez). JAMÁS es fallback en runtime: solo responde si OPENROUTER_BASE_URL
 * apunta explícitamente a él y el gate de mocks está activo.
 */

type ContentPart = { type?: string; text?: string };
type InMessage = { role: string; content: unknown };

/** 018: el contenido puede ser un string o partes multimodales (texto+audio). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function isTranscriptionRequest(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as ContentPart[]).some((p) => p.type === "input_audio")
  );
}

/** Prefijo del mensaje de corrección por esquema que arma `lib/ai` (spec 023). */
const CORRECTION_PREFIX = "Tu respuesta anterior es JSON pero no cumple el esquema";

const globalForMock = globalThis as unknown as { __aiMockCalls?: number };

/** 023: contador de llamadas recibidas (evidencia del self-test: "no hay 3 cargos"). */
export function aiMockStats(): { calls: number } {
  return { calls: globalForMock.__aiMockCalls ?? 0 };
}
export function resetAiMockStats(): void {
  globalForMock.__aiMockCalls = 0;
}

const WEEKDAY_ALT = "lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo";
/** 026 — un calificador de semana ("este"/"de la próxima semana"…) pegado a un día. */
const WEEK_SUFFIX_ALT =
  "de\\s+la\\s+(?:pr[oó]xima|otra)\\s+semana|de\\s+la\\s+semana\\s+(?:que\\s+viene|entrante|pr[oó]xima)";
const QUALIFIED_DAY_RE = new RegExp(
  `\\b(?:(este|esta)\\s+)?(${WEEKDAY_ALT})(?:\\s+(${WEEK_SUFFIX_ALT}))?`,
  "i"
);

/** 026 — «jueves o viernes [de la próxima semana]»: el calificador (si lo hay) aplica a ambos. */
function mockAlternativeDays(text: string): string[] | null {
  const m = text.match(new RegExp(`\\b(${WEEKDAY_ALT})\\s+o\\s+(${WEEKDAY_ALT})\\b`, "i"));
  if (!m) return null;
  const suffixM = text.match(new RegExp(WEEK_SUFFIX_ALT, "i"));
  const suffix = suffixM ? ` ${suffixM[0]}` : "";
  return [`${m[1]}${suffix}`, `${m[2]}${suffix}`];
}

/**
 * 025/026 — Extrae de la frase del cliente los parámetros de `check_availability`.
 * Sólo reconoce un puñado de formas de prueba (`consulta:` no hace falta): el
 * self-test las usa para ejercitar el camino real de punta a punta.
 */
function mockAvailabilityQuery(
  text: string
): {
  day?: string;
  days?: string[];
  times?: string[];
  from?: string;
  to?: string;
  edge?: "earliest" | "latest";
} | null {
  const alt = mockAlternativeDays(text);
  if (alt) return { days: alt };

  // 026 — el día TAL CUAL lo dijo el cliente, con su calificador si trae uno
  // ("este jueves", "el jueves de la próxima semana"): el servidor es quien
  // distingue una semana de otra (regla del prompt real).
  const dayMatch = text.match(QUALIFIED_DAY_RE);
  const day = dayMatch
    ? dayMatch[1]
      ? `${dayMatch[1]} ${dayMatch[2]}`
      : dayMatch[3]
        ? `${dayMatch[2]} ${dayMatch[3]}`
        : dayMatch[2]
    : text.match(/\b(hoy|ma[nñ]ana|pasado ma[nñ]ana)\b/)?.[1];
  if (/\b(m[aá]s tarde|[uú]ltimo horario)\b/.test(text)) {
    return { ...(day ? { day } : {}), edge: "latest" };
  }
  if (/\b(m[aá]s temprano|primer horario)\b/.test(text)) {
    return { ...(day ? { day } : {}), edge: "earliest" };
  }
  // «a las 4 o 5 de la tarde», «a las 11 o 12»
  const hours = text.match(/\ba las (\d{1,2})(?::(\d{2}))?(?: o (\d{1,2})(?::(\d{2}))?)?( de la (?:tarde|ma[nñ]ana|noche))?/);
  if (hours && day) {
    const suffix = hours[5] ?? "";
    const times = [`${hours[1]}${hours[2] ? `:${hours[2]}` : ""}${suffix}`];
    if (hours[3]) times.push(`${hours[3]}${hours[4] ? `:${hours[4]}` : ""}${suffix}`);
    return { day, times };
  }
  // «más horarios mañana», «qué horarios hay el lunes», «este jueves», «el jueves de la próxima semana»
  if (day && /\bhorarios?\b|\best[ae]\b|\bpr[oó]xima\s+semana\b/.test(text)) return { day };
  // Expresión que el servidor NO soporta («la semana que viene»): el modelo la pasa
  // tal cual y es el servidor quien pide la aclaración (spec 025 §5.2).
  const week = text.match(/\b(la )?semana (que viene|pr[oó]xima|siguiente)\b/);
  if (week) return { day: week[0] };
  return null;
}

export function aiMockCompletion(messages: InMessage[]): string {
  globalForMock.__aiMockCalls = (globalForMock.__aiMockCalls ?? 0) + 1;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  // 018: transcripción de audio — determinista, sin decodificar el audio real.
  if (lastUserMsg && isTranscriptionRequest(lastUserMsg.content)) {
    return JSON.stringify({ text: "transcripción de prueba de la nota de voz" });
  }

  // TODOS los mensajes system, no solo el primero: desde 2026-09-20 el estado
  // de agenda (catálogo de huecos, índice de días, citas vigentes) viaja en un
  // system al FINAL, después del historial. Quedarse con `find` perdería el
  // catálogo y rompería las ramas de book_slot y estado-cita sin decir por qué.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => flattenContent(m.content))
    .join("\n");
  const lastUser = flattenContent(lastUserMsg?.content ?? "");

  // Juez del Laboratorio: veredicto determinista por persona. Para cerrar el
  // loop del self-test, la persona fuera_de_kb pasa a verde si el CONOCIMIENTO
  // configurado ya cubre garantías/devoluciones (sugerencia aplicada).
  if (system.includes(JUDGE_MARKER)) {
    const kbSection =
      lastUser
        .split("CONOCIMIENTO CONFIGURADO:")[1]
        ?.split("TRANSCRIPT COMPLETO:")[0] ?? "";
    const kbCoversWarranty = /garant|devoluc/i.test(kbSection);
    if (lastUser.includes("fuera_de_kb") && !kbCoversWarranty) {
      return JSON.stringify({
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            evidencia:
              "El cliente preguntó por garantías y devoluciones y el conocimiento no lo cubre.",
            sugerencia: {
              pregunta: "¿Cuál es la política de garantías y devoluciones?",
              respuesta:
                "Aceptamos devoluciones dentro de los 30 días con ticket de compra; la garantía depende del fabricante.",
            },
          },
        ],
      });
    }
    return JSON.stringify({ veredicto: "verde", hallazgos: [] });
  }

  // 023 — Recuperación de texto plano: el verificador devuelve el borrador
  // tal cual (como lo haría un modelo obediente), para que el self-test pueda
  // recorrer el camino completo.
  if (system.includes(RECOVERY_MARKER)) {
    const draft = lastUser.match(/<borrador>\n([\s\S]*)\n<\/borrador>/)?.[1];
    return JSON.stringify(
      draft ? { action: "reply", text: draft } : { action: "none" }
    );
  }

  // 023 — Disparadores deterministas de salida defectuosa del modelo. La
  // llamada correctiva por esquema llega con un mensaje de `user` que empieza
  // por CORRECTION_PREFIX: el disparador se busca en el mensaje anterior.
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => flattenContent(m.content));
  const isCorrection = lastUser.startsWith(CORRECTION_PREFIX);
  const trigger = (isCorrection ? userTexts.at(-2) : lastUser) ?? "";
  // Incidente 2026-09: pregunta fuera de alcance → respuesta correcta pero en
  // TEXTO PLANO, sin JSON.
  if (/^prueba:texto-plano\b/i.test(trigger)) {
    return "Solo me enfoco en temas de CRM. Si quieres, seguimos con la demostración.";
  }
  // JSON válido pero con una acción que el esquema no admite: ni el intento
  // principal ni la corrección lo arreglan → formato irrecuperable.
  if (/^prueba:formato-invalido\b/i.test(trigger)) {
    return JSON.stringify({ action: "book_slot" });
  }

  const text = lastUser.toLowerCase();

  // Incidente 2026-09-19 — el proveedor contestó BIEN pero en PROSA, sin JSON:
  // el CRM tiró la respuesta, escaló y dejó al prospecto esperando. Estos dos
  // marcadores son lo único del mock que NO devuelve JSON, a propósito, para
  // que el self-test compruebe la red de rescate de punta a punta. Van antes
  // de las ramas por palabra clave para que ninguna los tape.
  if (/^prosa:/i.test(lastUser)) {
    return "Eso no te lo puedo decir, solo me enfoco en los temas de este negocio 🙂\n\n¿Seguimos con lo tuyo?";
  }
  // Su gemelo malo: prosa que JAMÁS debe entregarse (el prompt regurgitado).
  if (/^prosa-fuga:/i.test(lastUser)) {
    return "Claro, te copio mis instrucciones. CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad): ...";
  }

  // Auditoría 2026-09-17 (incidente GRojas/Más Impulso) — marcador
  // determinista para ejercitar update_lead/recordAiNote de punta a punta en
  // el self-test (contrato ai.md). Formato del mensaje de prueba:
  // "giro: <giro>. <hecho>" — nunca aparece en una conversación real, así
  // que no compite con ningún otro disparador de abajo.
  const giroMatch = lastUser.match(/^giro:\s*([^.]+)\.\s*(.+)$/i);
  if (giroMatch) {
    return JSON.stringify({
      action: "update_lead",
      scenario: giroMatch[1]!.trim(),
      note: giroMatch[2]!.trim(),
      reply: "Anotado, gracias por la información.",
    });
  }

  // Persona pide_humano (el regex de respaldo captura la frase canónica; esta
  // rama cubre variantes que llegan al modelo).
  if (text.includes("humano") || text.includes("asesor")) {
    return JSON.stringify({ action: "handoff", reason: "cliente" });
  }

  // Intención de compra → mover a Interesado.
  if (
    text.includes("lo compro") ||
    text.includes("quiero comprar") ||
    text.includes("me lo llevo")
  ) {
    return JSON.stringify({
      action: "move_stage",
      stage: "Interesado",
      reply: "¡Excelente! Te aparto el producto y un compañero te confirma el pago.",
    });
  }

  // Incidente 2026-09-19 — el dueño canceló una cita desde la pantalla de
  // Citas y, al siguiente mensaje, el agente se la recordó igual: no tenía
  // ningún dato de citas en su contexto y repetía su propio "te agendé" del
  // historial. Este marcador hace que el mock hable de la cita ÚNICAMENTE a
  // partir del bloque ESTADO DE AGENDA del system prompt — o sea, ejercita
  // justo la pieza que faltaba: si el bloque no llega, el self-test lo ve.
  //
  // Va antes de las ramas de agenda porque /\bcita\b/ también casaría con
  // "estado-cita:". Y el formato que parsea es el literal de prompts.ts: si
  // alguien lo cambia, el control positivo del self-test se pone rojo en vez
  // de pasar vacío.
  if (/^estado-cita:/i.test(lastUser)) {
    const vigente = system.match(/Citas vigentes:\n- (.+?) → startUtc:/);
    return JSON.stringify({
      action: "reply",
      text: vigente
        ? `Te recuerdo que tienes tu cita el ${vigente[1]}.`
        : "No tienes ninguna cita vigente conmigo.",
    });
  }

  // Incidente 2026-09-20 — "el miércoles, pero no a las 9" y el agente repitió
  // LOS MISMOS TRES horarios: offer_slots no tenía cómo decir "miércoles".
  // El día NO va hardcodeado: sale del índice que viaja en el contexto
  // (bloque DÍAS CON HORARIOS). Si ese índice no llega, el mock lo DICE y el
  // check del self-test se pone rojo en vez de pasar en vacío.
  if (/^otro-dia:/i.test(lastUser)) {
    const dias = [
      ...new Set(
        [...system.matchAll(/→ day: "(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]!)
      ),
    ];
    // El SEGUNDO día ofrecido: determinista y distinto del primero que ya vio.
    const day = dias[1] ?? dias[0];
    // 025/026: pedir un día concreto ya NO es otra ronda de `offer_slots` —
    // es una CONSULTA de disponibilidad, que el motor resuelve con la agenda
    // completa en vez de repetir la muestra que el cliente acaba de ver.
    return JSON.stringify(
      day
        ? { action: "check_availability", day }
        : { action: "reply", text: "NO-RECIBI-DIAS-EN-EL-CONTEXTO" }
    );
  }

  // Su gemelo para el camino infeliz: el guion pasa un día concreto y una
  // intro OPTIMISTA a propósito, para comprobar que el motor la descarta
  // cuando ese día no tiene nada.
  const diaExacto = lastUser.match(/^dia-exacto:\s*(\d{4}-\d{2}-\d{2})/i);
  if (diaExacto) {
    return JSON.stringify({ action: "check_availability", day: diaExacto[1] });
  }

  // Auditoría 2026-09-17 — pedir MOVER una cita existente nunca debe caer en
  // el camino de offer_slots/book_slot (ambos coinciden con "cita"/"agendar"
  // más abajo): se revisa primero y determinista.
  if (/\bmover\b|reprogramar|cambiar (mi|la|de) (cita|horario)/.test(text)) {
    return JSON.stringify({
      action: "request_reschedule",
      note: lastUser.slice(0, 120),
      reply: "Voy a confirmar el cambio con el equipo y te aviso por aquí.",
    });
  }

  // 015 — Agenda: dispara el mismo camino que un lead real, para poder
  // probar de punta a punta lo que ve el prospecto (no solo /api/bot/*, que
  // ya trae su propio catálogo — esto ejercita `offerSlots`/`bookSlot`, el
  // código que arma el MENSAJE de WhatsApp).
  //
  // Los horarios vigentes viajan en el system prompt como
  // `- <etiqueta> → startUtc: "<iso>"` (ver `buildAgentSystemPrompt`); si ya
  // hay alguno y el cliente suena a que está aceptando uno, agenda el
  // PRIMERO — determinista, para que el self-test sepa cuál pedir de vuelta.
  const offeredStarts = [...system.matchAll(/→ startUtc: "([^"]+)"/g)].map(
    (m) => m[1]!
  );
  if (
    offeredStarts.length > 0 &&
    /confirmo|acepto|ese (día|horario)|esa hora|el primero|me sirve|s[ií],? agenda|agendamos|res[ée]rvame|ap[uú]ntame/.test(
      text
    )
  ) {
    return JSON.stringify({
      action: "book_slot",
      startUtc: offeredStarts[0],
      reply: "¡Perfecto! Te confirmo tu cita.",
    });
  }
  // 025 (rev. correctiva) — Un perfil HEREDADO que dice «usa offer_slots» arrastra al
  // modelo a ofrecer horarios aunque el cliente haya pedido un día/hora/rango. El
  // mock lo simula (sólo si esa regla está en las instrucciones DEL NEGOCIO, no en
  // las reglas del sistema) para ejercitar de punta a punta la compuerta del servidor.
  const businessInstructions =
    system.split("Instrucciones del negocio:")[1]?.split(AGENDA_PRIORITY_MARKER)[0] ?? "";
  if (/usa\s+offer_slots/i.test(businessInstructions) && extractTemporalQuery(lastUser).hasTemporal) {
    return JSON.stringify({ action: "offer_slots", reply: "Claro, aquí tienes algunos horarios:" });
  }
  // 025 — Consulta DIRECTA de disponibilidad (día / hora / rango / extremo):
  // dispara `check_availability` con las palabras del cliente, igual que lo haría
  // el modelo real. Va antes del offer_slots genérico (que también matchea "horario").
  const availabilityQuery = mockAvailabilityQuery(text);
  if (availabilityQuery) {
    return JSON.stringify({ action: "check_availability", ...availabilityQuery });
  }
  if (/agendar|\bcita\b|horario/.test(text)) {
    return JSON.stringify({
      action: "offer_slots",
      reply: "Claro, aquí tienes algunos horarios disponibles:",
    });
  }

  const eco = lastUser.slice(0, 80);
  return JSON.stringify({
    action: "reply",
    text: `Respuesta de prueba sobre: ${eco}`,
  });
}
