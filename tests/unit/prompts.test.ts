import { describe, expect, it } from "vitest";
import {
  buildAgendaNowMessage,
  buildAgentSystemPrompt,
  buildJudgePrompt,
  PROMPT_LEAK_MARKERS,
  JUDGE_MARKER,
} from "@/server/ai/prompts";

const profile = {
  id: "agentprofile_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

describe("buildAgentSystemPrompt — agenda (015)", () => {
  it("sin agenda, no menciona horarios ni gasta tokens en offers", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [],
      agenda: false,
    });
    expect(prompt).not.toContain("offer_slots");
    expect(prompt).not.toContain("book_slot");
    expect(prompt).not.toContain("Horarios vigentes");
  });

  it("con agenda pero sin oferta vigente, no incluye el bloque de horarios", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [],
      agenda: true,
      offers: [],
    });
    expect(prompt).toContain("offer_slots");
    expect(prompt).not.toContain("→ startUtc:");
  });

  it("con oferta vigente, expone el startUtc EXACTO para que book_slot no lo adivine", () => {
    // Este bloque se mudó al mensaje de estado que va DESPUÉS del historial.
    const msg = buildAgendaNowMessage({
      agenda: true,
      offers: [{ startUtc: "2026-09-16T15:00:00.000Z", label: "mié 16 sep, 09:00" }],
    });
    expect(msg).toContain("→ startUtc:");
    expect(msg).toContain("2026-09-16T15:00:00.000Z");
    expect(msg).toContain("mié 16 sep, 09:00");
  });

  it("la regla de copiar el startUtc sigue en el prompt estable", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [],
      agenda: true,
    });
    expect(prompt).toMatch(/COPIA TAL CUAL/);
  });
});

describe("contrato de salida y marcadores de fuga", () => {
  const prompt = buildAgentSystemPrompt({
    profile,
    kb: [],
    stages: [{ name: "Nuevo" }],
    agenda: false,
  });

  it("una pregunta fuera de tema se contesta con una acción JSON, no con prosa", () => {
    // Incidente 2026-09-19: el modelo declinó correctamente pero en texto
    // suelto, y el CRM tiró la respuesta. La regla tiene que decir
    // explícitamente que declinar TAMBIÉN es un reply.
    expect(prompt).toContain("AJENO al negocio");
    expect(prompt).toContain("Declinar TAMBIÉN es una acción JSON");
    // Un ejemplo literal rinde más que una instrucción abstracta en un modelo
    // pequeño: que nadie lo borre sin darse cuenta.
    expect(prompt).toContain('{"action":"reply"');
  });

  it("todos los marcadores de fuga existen DE VERDAD en un prompt construido", () => {
    // Si un marcador se desfasa del prompt, `salvageProse` deja de reconocer
    // el prompt regurgitado y el guardrail se apaga EN SILENCIO.
    const judge = buildJudgePrompt({
      persona: "p",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    for (const marker of PROMPT_LEAK_MARKERS) {
      const aparece =
        prompt.includes(marker) ||
        judge.system.includes(marker) ||
        marker === JUDGE_MARKER;
      expect(aparece, `el marcador "${marker}" ya no aparece en ningún prompt`).toBe(true);
    }
  });
});

/**
 * Incidente 2026-09-19 — el dueño canceló una cita desde la pantalla de Citas
 * y el agente se la siguió recordando: no tenía NINGÚN dato de citas en el
 * contexto y repetía su propio "¡Listo! Te agendé…" del historial.
 */
describe("ESTADO DE AGENDA — el bloque que le da al modelo la verdad", () => {
  const conAgenda = (
    agendaState?: Parameters<typeof buildAgendaNowMessage>[0]["agendaState"]
  ) => buildAgendaNowMessage({ agenda: true, agendaState }) ?? "";

  it("con cita vigente, expone la etiqueta humana Y el startUtc exacto", () => {
    const prompt = conAgenda({
      kind: "active",
      bookings: [
        { label: "lun 21 sep, 09:00", startUtc: "2026-09-21T15:00:00.000Z" },
      ],
    });
    expect(prompt).toContain("ESTADO DE AGENDA");
    expect(prompt).toContain("lun 21 sep, 09:00");
    // El instante exacto, igual que en los huecos ofrecidos: si el cliente
    // pide moverla, el equipo necesita el epoch, no una etiqueta humana.
    expect(prompt).toContain("2026-09-21T15:00:00.000Z");
  });

  it("sin cita lo dice EXPLÍCITAMENTE — el silencio no le gana al historial", () => {
    // Éste es el test del incidente. Si el bloque solo apareciera cuando hay
    // cita, en el caso cancelado el contexto quedaría idéntico al de antes
    // (una confirmación suya en el historial y cero contradicción) y el modelo
    // volvería a afirmar la cita.
    const prompt = conAgenda({ kind: "none" });
    expect(prompt).toContain("NO tiene NINGUNA cita vigente");
    expect(prompt).not.toContain("Citas vigentes:");
  });

  it("si no se pudo leer, no afirma nada en ninguna dirección", () => {
    // Degradar a "no tiene cita" sería afirmar algo falso al revés.
    const prompt = conAgenda({ kind: "unknown" });
    expect(prompt).toContain("no afirmes NINGUNA cita");
    expect(prompt).not.toContain("NO tiene NINGUNA cita vigente");
    expect(prompt).not.toContain("Citas vigentes:");
  });

  it("el bloque MANDA sobre el historial, y lo dice", () => {
    expect(conAgenda({ kind: "none" })).toContain("ÚNICA fuente de verdad");
    expect(conAgenda({ kind: "none" })).toContain(
      "MANDA sobre cualquier cosa dicha antes"
    );
  });

  it("sin agenda no gasta ni un token: el mensaje ni se emite", () => {
    expect(
      buildAgendaNowMessage({ agenda: false, agendaState: { kind: "none" } })
    ).toBeNull();
  });

  it("expone el índice de DÍAS para que el modelo pueda pedir otro sin calcular fechas", () => {
    // Incidente 2026-09-20: sin este índice, pedir "el miércoles" obligaba al
    // modelo a derivar la fecha, que es justo lo que no sabe hacer.
    const msg = buildAgendaNowMessage({
      agenda: true,
      offers: [{ startUtc: "2026-09-23T15:00:00.000Z", label: "mié 23 sep, 09:00" }],
      offerDays: [{ day: "2026-09-23", label: "miércoles 23 de septiembre" }],
    });
    expect(msg).toContain("DÍAS CON HORARIOS DISPONIBLES");
    expect(msg).toContain('→ day: "2026-09-23"');
  });

  it("ya no queda la regla que le ordenaba ignorar el estado real", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: true,
    });
    // La redacción vieja decía "nunca asumas que la cita anterior quedó
    // cancelada o movida". Con el bloque nuevo eso es una contradicción
    // DENTRO del mismo prompt, y el modelo la resuelve a favor de la
    // instrucción en vez del dato. Si alguien la revierte, este test lo caza.
    expect(prompt).not.toContain(
      "nunca asumas que la cita anterior quedó cancelada"
    );
    // …pero la mitad útil (no anunciar tú el cambio) sigue viva.
    expect(prompt).toContain("request_reschedule");
    expect(prompt).toContain("nunca anuncies TÚ que la cita quedó movida");
  });
});

/**
 * Incidente 2026-09-20 — el agente afirmó "las demostraciones las tenemos en
 * horario de mañana". No salía de ninguna configuración: lo dedujo de que los
 * tres huecos que vio eran a las 09:00.
 */
describe("HORARIO DE ATENCIÓN — el modelo deja de inferirlo de una muestra", () => {
  const horas = {
    lines: ["Lunes a viernes: 09:00–18:00"],
    closed: "sábado y domingo",
    timezone: "America/Mexico_City",
    today: "domingo 20 de septiembre",
    lastBookable: "domingo 27 de septiembre",
  };

  it("expone el horario real, los días cerrados y el ancla de HOY", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: true,
      businessHours: horas,
    });
    expect(prompt).toContain("HORARIO DE ATENCIÓN");
    expect(prompt).toContain("09:00–18:00");
    expect(prompt).toContain("sábado y domingo");
    // El prompt no tenía NINGUNA ancla temporal antes de esto.
    expect(prompt).toContain("Hoy es domingo 20 de septiembre");
  });

  it("sin el dato no se inventa el bloque", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: true,
    });
    expect(prompt).not.toContain("HORARIO DE ATENCIÓN");
  });

  it("con la agenda apagada no gasta ni un token en ello", () => {
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [],
      agenda: false,
      businessHours: horas,
    });
    expect(prompt).not.toContain("HORARIO DE ATENCIÓN");
  });

  it("la regla de pedir OTRO DÍA existe y nombra el campo", () => {
    // Si alguien la borra, el modelo vuelve a llamar offer_slots a secas y el
    // cliente recibe otra vez los mismos horarios.
    const prompt = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: true,
    });
    expect(prompt).toContain("`day`");
    expect(prompt).toContain("EXACTAMENTE los mismos horarios");
    expect(prompt).toContain("NO filtres tú por hora");
  });
});

/**
 * Incidente 2026-09-20 (segundo) — un prospecto preguntó si Vocero se integra
 * con ERPs, el agente respondió BIEN desde el knowledge base y preguntó qué
 * sistema usaba. El prospecto contestó "Salesforce" y el agente lo transfirió
 * a un humano. La cita se escapó estando a un paso.
 *
 * El prompt base le daba dos permisos y ningún objetivo: la regla de "fuera
 * del conocimiento" ofrecía escalar como alternativa de primera opción, y
 * nada decía que la meta de la conversación fuera dejar una cita agendada.
 */
describe("el sesgo a escalar y el objetivo de agendar", () => {
  const prompt = (agenda: boolean) =>
    buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda,
    });

  it("un hueco en el conocimiento YA NO autoriza traspasar", () => {
    // La redacción vieja: "…o {handoff} si hace falta una persona".
    const p = prompt(true);
    expect(p).not.toContain('o {"action":"handoff",...} si hace falta una persona');
    expect(p).toContain("TAMPOCO escales por eso");
  });

  it("la cabecera del knowledge base tampoco ofrece escalar de salida", () => {
    expect(prompt(true)).not.toContain(
      "di que lo confirmarás con el equipo o escala"
    );
  });

  it("mencionar una herramienta concreta no es motivo de traspaso, y lo dice", () => {
    // El caso literal del incidente: el prospecto dijo "Salesforce".
    expect(prompt(true)).toContain("NO es motivo de traspaso");
  });

  it("con agenda, el agente SABE que su objetivo es dejar una cita agendada", () => {
    const p = prompt(true);
    expect(p).toContain("TU OBJETIVO");
    expect(p).toContain("quede con una cita agendada");
    // Y el puente explícito: dato concreto del cliente → ofrecer horarios.
    expect(p).toContain("el siguiente paso natural es offer_slots");
  });

  it("…pero ofrecer no es insistir", () => {
    // Sin este contrapeso, el objetivo convierte al agente en un vendedor
    // pesado que propone agendar en cada turno.
    expect(prompt(true)).toContain("Ofrecer no es insistir");
  });

  it("sin agenda no se promete una cita que la instancia no puede dar", () => {
    const p = prompt(false);
    expect(p).not.toContain("TU OBJETIVO");
    expect(p).not.toContain("offer_slots");
  });
});

