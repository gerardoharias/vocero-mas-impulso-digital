import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  UnsupportedSchemaError,
  stripNulls,
  zodToStrictJsonSchema,
} from "@/lib/ai/json-schema";
import { AgentAction, agentActionSchema } from "@/server/ai/actions";
import { recoverySchema } from "@/server/ai/recovery";
import { Verdict } from "@/server/lab/judge";

/**
 * El JSON Schema que se le pide al proveedor sale de los MISMOS esquemas Zod
 * que validan la respuesta (spec 023, D2). Estos tests son lo que impide que
 * se desincronicen: cualquier esquema real que el conversor no entienda, o
 * cualquier variante que quede fuera del sobre, rompe el CI.
 */

type Strict = {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

describe("zodToStrictJsonSchema — esquemas reales", () => {
  for (const agenda of [false, true]) {
    describe(`agentActionSchema(agenda=${agenda})`, () => {
      const zod = agentActionSchema(agenda);
      const json = zodToStrictJsonSchema(zod) as Strict;
      const variants = (zod as unknown as { options: z.ZodObject<z.ZodRawShape>[] })
        .options;

      it("raíz object estricto: todo `required`, sin propiedades extra", () => {
        expect(json.type).toBe("object");
        expect(json.additionalProperties).toBe(false);
        expect(json.required.sort()).toEqual(Object.keys(json.properties).sort());
      });

      it("`action` enumera EXACTAMENTE las variantes de Zod (ni una de más, ni una de menos)", () => {
        const fromZod = variants.map((v) => (v.shape.action as z.ZodLiteral<string>).value);
        expect((json.properties.action as { enum: string[] }).enum).toEqual(fromZod);
      });

      it("cada campo de cada variante existe en el sobre; los opcionales/ajenos aceptan null", () => {
        for (const v of variants) {
          for (const [key, field] of Object.entries(v.shape)) {
            expect(json.properties).toHaveProperty(key);
            if (key !== "action" && (field as z.ZodTypeAny).isOptional()) {
              expect(JSON.stringify(json.properties[key])).toContain('"type":"null"');
            }
          }
        }
      });

      it("una respuesta estricta por variante (con null en lo ajeno) sobrevive a stripNulls + Zod", () => {
        const samples: Record<string, Record<string, unknown>> = {
          none: { action: "none" },
          reply: { action: "reply", text: "hola" },
          update_lead: { action: "update_lead", note: "quiere 3 unidades", scenario: "plomería" },
          move_stage: { action: "move_stage", stage: "Interesado" },
          handoff: { action: "handoff", farewell: "gracias" },
          offer_slots: { action: "offer_slots", reply: "claro" },
          book_slot: { action: "book_slot", startUtc: "2026-09-20T15:00:00Z", reason: "cotizar" },
          request_reschedule: { action: "request_reschedule", note: "mover a viernes" },
          // 025: consulta directa; sin `reply`, con arreglo de horas y `edge` enum.
          check_availability: {
            action: "check_availability",
            day: "lunes",
            times: ["11", "4 de la tarde"],
            edge: "latest",
          },
        };
        for (const v of variants) {
          const name = (v.shape.action as z.ZodLiteral<string>).value;
          const strictLike: Record<string, unknown> = {};
          for (const key of Object.keys(json.properties)) strictLike[key] = null;
          Object.assign(strictLike, samples[name]);
          const parsed = zod.safeParse(stripNulls(strictLike));
          expect(parsed.success, `variante ${name}`).toBe(true);
        }
      });
    });
  }

  it("`agenda=false` no expone las acciones de agenda al modelo", () => {
    const json = zodToStrictJsonSchema(agentActionSchema(false)) as Strict;
    const actions = (json.properties.action as { enum: string[] }).enum;
    expect(actions).not.toContain("book_slot");
    expect(actions).not.toContain("offer_slots");
    expect(actions).not.toContain("request_reschedule");
  });

  it("AgentAction completo coincide con agentActionSchema(true)", () => {
    expect(zodToStrictJsonSchema(AgentAction)).toEqual(
      zodToStrictJsonSchema(agentActionSchema(true))
    );
  });

  it("Verdict (juez): anidados, arrays y opcionales convertidos", () => {
    const json = zodToStrictJsonSchema(Verdict) as Strict;
    expect(json.required).toEqual(["veredicto", "hallazgos"]);
    const hallazgos = json.properties.hallazgos as {
      type: string;
      items: Strict;
    };
    expect(hallazgos.type).toBe("array");
    expect(hallazgos.items.additionalProperties).toBe(false);
    expect(hallazgos.items.required).toEqual(["tipo", "evidencia", "sugerencia"]);
    expect(JSON.stringify(hallazgos.items.properties.sugerencia)).toContain('"type":"null"');
  });

  it("esquema de la recuperación de texto plano: SOLO reply | none", () => {
    const json = zodToStrictJsonSchema(recoverySchema) as Strict;
    expect((json.properties.action as { enum: string[] }).enum).toEqual(["none", "reply"]);
  });

  it("transcripción ({text})", () => {
    expect(zodToStrictJsonSchema(z.object({ text: z.string() }))).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
  });
});

describe("zodToStrictJsonSchema — fuera del subconjunto FALLA en voz alta", () => {
  it("transform / union / record / tuple no se ignoran en silencio", () => {
    expect(() =>
      zodToStrictJsonSchema(z.object({ n: z.number().transform((x) => x) }))
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      zodToStrictJsonSchema(z.object({ u: z.union([z.string(), z.number()]) }))
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      zodToStrictJsonSchema(z.object({ r: z.record(z.string()) }))
    ).toThrow(UnsupportedSchemaError);
  });

  it("la raíz debe ser un objeto", () => {
    expect(() => zodToStrictJsonSchema(z.string())).toThrow(UnsupportedSchemaError);
  });
});

describe("stripNulls", () => {
  it("quita las propiedades null, recursivamente, y respeta el resto", () => {
    expect(
      stripNulls({ a: null, b: "x", c: { d: null, e: 0 }, f: [{ g: null, h: false }] })
    ).toEqual({ b: "x", c: { e: 0 }, f: [{ h: false }] });
  });
});
