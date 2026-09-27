import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import {
  bootScenario,
  deliverInbound,
  organizationId,
  resetData,
  settle,
  teardownScenario,
} from "./helpers/scenario";

/**
 * Spec 026 — memoria de aclaración de disponibilidad: calificador de semana
 * ("este" vs "de la próxima semana"), contexto que se hereda entre turnos
 * (regla 10), días alternativos (`days[]`), aclaración que no se repite +
 * fechas concretas (regla 14), y escalamiento a un humano tras 3 intentos
 * consecutivos sin resolver (regla 15). Todo contra Postgres REAL (`resetData`)
 * y el pipeline REAL (`deliverInbound` → `processMessagesValue` → `runAgentTurn`);
 * sólo la respuesta del "modelo" está guionada (`harness.ai.script`) — el motor
 * de disponibilidad, la resolución de fechas y la persistencia son el código real.
 *
 * «Ahora» = jueves 17 sep 2026, 12:00 hora de Ciudad de México (igual que 025).
 */

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-17T18:00:00Z"));
  await bootScenario();
});
afterAll(async () => {
  vi.useRealTimers();
  await teardownScenario();
});
beforeEach(async () => {
  harness.reset();
  harness.availability.useReal = true;
  await resetData();
});

const model = (data: Record<string, unknown>) => ({ ok: true, data, raw: "{}" });

async function ask(text: string) {
  const { wamid } = await deliverInbound({ text, timestamp: Math.floor(Date.now() / 1000) });
  // Alinea `created_at` del entrante con el reloj FALSEADO del proceso: el
  // default de esa columna es `now()` de POSTGRES, que corre en un contenedor
  // aparte y no conoce `vi.setSystemTime`. Sin esto, un entrante (reloj real)
  // puede figurar cronológicamente ANTES que la respuesta del turno anterior
  // (reloj falseado, `outbox` sí usa `new Date()` de la app) y el pipeline
  // pierde el límite entre "lo que dijo el cliente en ESTE turno" y el
  // anterior (`lastOut` en `runAgentTurn`). Sólo del arnés: nunca en producción.
  const { getDb, schema } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  await getDb().update(schema.message).set({ createdAt: new Date() }).where(eq(schema.message.waMessageId, wamid));
  const snap = await settle();
  const out = snap.messages.filter((m) => m.direction === "out");
  return { snap, out, body: out.at(-1)?.text ?? "", conv: snap.conversations[0]! };
}

describe("026 — «este <día>» ya pasó: aclara, recuerda, y NO reinterpreta en silencio (regla 5)", () => {
  it("«este lunes» (el lunes de esta semana, 14, ya pasó) pide aclaración y guarda el contexto", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "este lunes" }));
    const { conv, body, snap } = await ask("¿Tienes el lunes de esta semana?");

    expect(body).toContain("ya pasó");
    expect(body).toContain("próxima semana");
    expect(snap.offers).toHaveLength(0); // ninguna hora inventada ni registrada
    expect(conv.agendaClarifyCount).toBe(1);
    expect(conv.agendaClarifyKind).toBe("already_passed_this_week");
    expect(JSON.parse(conv.agendaClarifyContext ?? "{}")).toEqual({ days: ["este lunes"] });
    expect(conv.handoffAt).toBeNull();
  });

  it("segundo intento consecutivo: el texto NO se repite (varía a la pregunta corta)", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "este lunes" }));
    const first = await ask("¿el lunes de esta semana?");
    harness.ai.script.push(model({ action: "check_availability", day: "este lunes" }));
    const second = await ask("de esta semana");
    expect(second.body).not.toBe(first.body);
    expect(second.body).toBe("¿Esta semana o la próxima?");
    expect(second.conv.agendaClarifyCount).toBe(2);
  });
});

describe("026 — contexto heredado entre turnos (regla 10, sin depender del modelo)", () => {
  it("«la semana que viene» (sin día) → aclara y recuerda; «el jueves» solo hereda 'próxima semana'", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    const first = await ask("¿Tienes disponibilidad la semana que viene?");
    expect(first.conv.agendaClarifyKind).toBe("unresolved_day");
    expect(JSON.parse(first.conv.agendaClarifyContext ?? "{}")).toEqual({ weekModifier: "next" });

    // El modelo NO combina turnos (D5 del diagnóstico): pasa "el viernes" tal
    // cual, como haría un modelo real. El SERVIDOR debe resolverlo a la semana
    // SIGUIENTE (25 sep). (No se usa "jueves": hoy ES jueves, así que el más
    // cercano y el de la semana siguiente coinciden por aritmética — "viernes"
    // sí distingue.) El 25 cae FUERA del horizonte por defecto (7 días, hasta
    // el 24): la herencia nunca inventa disponibilidad — dice la verdad del
    // horizonte en vez de fingir que el 25 está disponible (regla 9 / AC-11),
    // y ESO ya prueba que heredó "próxima semana" (si hubiera usado el más
    // cercano, 18 sep, sí habría caído dentro del horizonte con horarios reales).
    harness.ai.script.push(model({ action: "check_availability", day: "viernes" }));
    const second = await ask("para el viernes");
    expect(second.body).toContain("Por ahora agendo hasta el jueves, 24 de septiembre");
    expect(second.conv.agendaClarifyCount).toBe(0); // se resolvió (con una negativa honesta): el contador se limpia
    expect(second.conv.agendaClarifyKind).toBeNull();
  });

  it("respuesta corta contextual («sí») entre medias: NO limpia el contexto por sí sola (regla del dueño)", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    const first = await ask("la semana que viene");
    expect(first.conv.agendaClarifyKind).toBe("unresolved_day");

    // El modelo responde con una acción NO relacionada con agenda a un "sí" corto:
    // eso SOLO no basta para limpiar el contexto (regla del dueño, isUnambiguousTopicChange).
    harness.ai.script.push(model({ action: "reply", text: "Perfecto." }));
    const middle = await ask("sí");
    expect(middle.conv.agendaClarifyCount).toBe(1); // sigue pendiente
    expect(JSON.parse(middle.conv.agendaClarifyContext ?? "{}")).toEqual({ weekModifier: "next" });

    // Y el contexto SIGUE disponible para el turno siguiente (mismo razonamiento
    // que arriba: "25 sep" fuera de horizonte prueba que heredó "próxima semana").
    harness.ai.script.push(model({ action: "check_availability", day: "viernes" }));
    const last = await ask("el viernes");
    expect(last.body).toContain("Por ahora agendo hasta el jueves, 24 de septiembre");
  });

  it("con un horizonte más ancho, el calificador heredado SÍ resuelve a horarios reales (25 sep)", async () => {
    const { upsertSettings } = await import("@/server/agenda/settings");
    await upsertSettings(organizationId, { maxDaysAhead: 14 });

    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    await ask("la semana que viene");
    harness.ai.script.push(model({ action: "check_availability", day: "viernes" }));
    const { body, snap } = await ask("el viernes");
    expect(body).toContain("Viernes, 25 de septiembre puedo iniciar");
    expect(snap.offers.some((o) => o.startUtc.toISOString().startsWith("2026-09-25"))).toBe(true);
  });

  it("cambio INEQUÍVOCO de tema limpia el contexto: un «el viernes» posterior ya NO hereda 'próxima semana'", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    await ask("la semana que viene");

    // Mensaje claramente de otro tema, sin nada temporal ni respuesta corta.
    harness.ai.script.push(model({ action: "reply", text: "El precio depende del paquete que elijas." }));
    const middle = await ask("¿cuánto cuesta el servicio básico?");
    expect(middle.conv.agendaClarifyCount).toBe(0);
    expect(middle.conv.agendaClarifyKind).toBeNull();

    harness.ai.script.push(model({ action: "check_availability", day: "viernes" }));
    const last = await ask("el viernes");
    expect(last.body).toContain("18 de septiembre"); // el más CERCANO, no heredó nada
  });

  it("un handoff por un motivo AJENO a la agenda (regla 11-d: 'interviene una persona') también limpia el contexto pendiente", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    const first = await ask("la semana que viene");
    expect(first.conv.agendaClarifyCount).toBe(1);

    // Patrón de respaldo ANTES del LLM (matchesHandoffIntent): no gasta ninguna llamada de IA.
    const before = harness.ai.calls;
    const after = await ask("quiero hablar con una persona");
    expect(harness.ai.calls).toBe(before); // sin llamada nueva: el patrón corta antes
    expect(after.conv.handoffReason).toBe("cliente");
    expect(after.conv.agendaClarifyCount).toBe(0);
    expect(after.conv.agendaClarifyKind).toBeNull();
    expect(after.conv.agendaClarifyContext).toBeNull();
  });
});

describe("026 — días alternativos («jueves o viernes», regla 12)", () => {
  it("ambos se consultan y se presentan en el orden del cliente, con datos reales del motor", async () => {
    harness.ai.script.push(model({ action: "check_availability", days: ["jueves", "viernes"] }));
    const { body, snap } = await ask("¿Jueves o viernes?");
    const lines = body.split("\n");
    expect(lines[0]).toContain("Jueves, 24 de septiembre");
    expect(lines[1]).toContain("18 de septiembre");
    expect(snap.offers.length).toBeGreaterThan(0);
    expect(harness.ai.calls).toBe(1); // una sola llamada de IA
  });
});

describe("026 — límite de aclaraciones: escala a un humano en el 3.er intento (regla 15)", () => {
  it("tres aclaraciones consecutivas sin resolver ⇒ handoff `agenda_ambigua`, sin volver a preguntar", async () => {
    harness.ai.script.push(model({ action: "check_availability", day: "no sé cuándo" }));
    const first = await ask("no sé cuándo, tal vez");
    expect(first.conv.agendaClarifyCount).toBe(1);
    expect(first.conv.handoffAt).toBeNull();

    harness.ai.script.push(model({ action: "check_availability", day: "sigo sin saber" }));
    const second = await ask("mmm no sé");
    expect(second.conv.agendaClarifyCount).toBe(2);
    expect(second.conv.handoffAt).toBeNull();
    expect(second.body).not.toBe(first.body); // nunca el mismo texto dos veces

    harness.ai.script.push(model({ action: "check_availability", day: "otra vez no sé" }));
    const third = await ask("de plano no sé");
    expect(third.conv.handoffAt).not.toBeNull();
    expect(third.conv.handoffReason).toBe("agenda_ambigua");
    expect(third.conv.agendaClarifyCount).toBe(0); // el handoff limpia el contador
    expect(third.body).not.toContain("¿Para qué día"); // ya NO vuelve a preguntar
  });
});

describe("026 — nunca inventa disponibilidad (invariante, extiende 025 §4)", () => {
  it("los horarios de `days[]` son EXACTAMENTE los del motor (oráculo independiente)", async () => {
    harness.ai.script.push(model({ action: "check_availability", days: ["lunes", "martes"] }));
    const { snap } = await ask("¿lunes o martes?");
    const { computeAvailability } = await import("@/server/agenda/availability");
    const { getSettings } = await import("@/server/agenda/settings");
    const settings = await getSettings(organizationId);
    const truth = await computeAvailability(organizationId, { settings, now: new Date() });
    const freeSet = new Set(truth.map((s) => s.startUtc));
    for (const o of snap.offers) {
      expect(freeSet.has(o.startUtc.toISOString()), `ofreció ${o.startUtc.toISOString()} que el motor no confirma`).toBe(
        true
      );
    }
  });
});

describe("026 — aislamiento del contexto (regla del dueño: nunca compartido entre conversaciones/organizaciones)", () => {
  it("dos conversaciones DISTINTAS de la MISMA organización nunca comparten el contexto pendiente", async () => {
    // Prospecto A deja pendiente "la próxima semana"; Prospecto B nunca la mencionó.
    harness.ai.script.push(model({ action: "check_availability", day: "la semana que viene" }));
    await deliverInbound({ text: "la semana que viene", from: "5215500000101", timestamp: Math.floor(Date.now() / 1000) });
    await settle();

    // B, en su PROPIA conversación, pregunta por "el jueves" sin haber dicho nada de semanas.
    harness.ai.script.push(model({ action: "check_availability", day: "jueves" }));
    const wamidB = await deliverInbound({
      text: "el jueves",
      from: "5215500000102",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    await getDb()
      .update(schema.message)
      .set({ createdAt: new Date() })
      .where(eq(schema.message.waMessageId, wamidB.wamid));
    const snap = await settle();

    const convs = snap.conversations;
    const convA = convs.find((c) => c.agendaClarifyKind === "unresolved_day");
    expect(convA, "A debe tener el contexto pendiente").toBeDefined();
    expect(JSON.parse(convA!.agendaClarifyContext ?? "{}")).toEqual({ weekModifier: "next" });

    const outB = snap.messages.filter((m) => m.direction === "out" && m.conversationId !== convA!.id);
    const bodyB = outB.at(-1)?.text ?? "";
    // B jamás heredó el "próxima semana" de A: "el jueves" a secas resuelve al más CERCANO (24 sep).
    expect(bodyB).toContain("24 de septiembre");
    expect(bodyB).not.toContain("1 de octubre");
    const convB = convs.find((c) => c.id !== convA!.id);
    expect(convB?.agendaClarifyCount).toBe(0); // B resolvió: nada pendiente, y nunca tuvo nada de A
  });

  it("dos ORGANIZACIONES distintas nunca comparten el contexto pendiente (acotado por organization_id en la propia capa de persistencia)", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    const { newId } = await import("@/lib/db/ids");
    const {
      loadAgendaClarifyState,
      writeAgendaClarifyState,
      resetAgendaClarifyState,
    } = await import("@/server/agenda/agenda-clarify-state");
    const db = getDb();

    // Conversación real de la organización A (la del escenario) con contexto pendiente.
    await deliverInbound({ text: "hola", timestamp: Math.floor(Date.now() / 1000) });
    const [convA] = await db.select().from(schema.conversation).limit(1);
    if (!convA) throw new Error("no se creó la conversación de la organización A");
    await writeAgendaClarifyState(
      { id: convA.id, organizationId: convA.organizationId },
      0,
      { count: 1, kind: "unresolved_day", context: { weekModifier: "next" } }
    );

    // Organización B: mínima, con su propia conversación, pero el MISMO conversationId
    // no puede repetirse (clave primaria) — se usa un id propio para probar el filtro real:
    // dos filas con `organization_id` distinto y `id` distinto, atacadas ambas por su
    // `organizationId` real (el caso que de verdad importa: nunca una organización lee o
    // pisa el estado de otra, aunque conociera el id de la conversación ajena).
    const orgB = newId("organization");
    await db.insert(schema.organization).values({ id: orgB, name: "Org B (aislamiento)", slug: `it-${orgB}` });
    const contactB = newId("contact");
    await db.insert(schema.contact).values({ id: contactB, organizationId: orgB, waIdentity: "5215500000199", name: "Contacto B" });
    const convBId = newId("conversation");
    await db.insert(schema.conversation).values({ id: convBId, organizationId: orgB, contactId: contactB });

    // B nunca escribió nada: su estado nace vacío.
    const [convBRow] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, convBId));
    expect(loadAgendaClarifyState(convBRow!)).toEqual({ count: 0, kind: null, context: null });

    // Un intento de LEER el contexto de A usando el id de A pero la organización de B
    // (la forma exacta en que una fuga cruzaría organizaciones) no debe aplicar ninguna
    // escritura: `writeAgendaClarifyState`/`resetAgendaClarifyState` van acotados por
    // `id` + `organizationId` A LA VEZ — con el organizationId equivocado, el WHERE no
    // encuentra la fila de A y no toca nada.
    await writeAgendaClarifyState({ id: convA.id, organizationId: orgB }, 1, {
      count: 5,
      kind: "too_many_days",
      context: null,
    });
    const [convAAfter] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, convA.id));
    expect(loadAgendaClarifyState(convAAfter!)).toEqual({
      count: 1,
      kind: "unresolved_day",
      context: { weekModifier: "next" },
    }); // intacto: la escritura con la organización equivocada NO aplicó

    await resetAgendaClarifyState({ id: convA.id, organizationId: orgB });
    const [convAAfter2] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, convA.id));
    expect(loadAgendaClarifyState(convAAfter2!)).toEqual({
      count: 1,
      kind: "unresolved_day",
      context: { weekModifier: "next" },
    }); // el reseteo con la organización equivocada TAMPOCO aplicó

    // Limpieza: la organización B es sólo de esta prueba.
    await db.delete(schema.conversation).where(eq(schema.conversation.id, convBId));
    await db.delete(schema.contact).where(eq(schema.contact.id, contactB));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgB));
  });
});
