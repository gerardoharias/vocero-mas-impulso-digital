import { z } from "zod";

/**
 * Zod → JSON Schema en el dialecto ESTRICTO de los proveedores (spec 023, D2).
 *
 * Por qué propio y no `zod-to-json-schema`: cero dependencias nuevas
 * (Constitución II), y el modo estricto pide una forma que ninguna librería
 * genérica produce tal cual: raíz `object`, todas las propiedades `required`,
 * `additionalProperties:false` y los opcionales como `anyOf[T, null]`.
 *
 * Es un SUBCONJUNTO deliberado (lo que usan hoy el agente, el juez y la
 * transcripción). Un tipo fuera del subconjunto LANZA `UnsupportedSchemaError`
 * en vez de ignorarse: el llamador baja a `json_object` y lo registra. Zod
 * sigue siendo la última frontera — el JSON Schema es una petición al
 * proveedor, nunca la validación.
 *
 * Las restricciones `min/max/trim` no viajan (no todo proveedor las acepta en
 * modo estricto): las aplica Zod al validar la respuesta.
 */

export type JsonSchema = Record<string, unknown>;

export class UnsupportedSchemaError extends Error {
  constructor(typeName: string) {
    super(`tipo Zod fuera del subconjunto soportado: ${typeName}`);
    this.name = "UnsupportedSchemaError";
  }
}

type AnyDef = { typeName?: string } & Record<string, unknown>;
const defOf = (s: z.ZodTypeAny): AnyDef => s._def as AnyDef;

/** `anyOf[T, null]`. Si `T` ya es un `anyOf`, se aplana (sin anidar uniones). */
const nullable = (inner: JsonSchema): JsonSchema => ({
  anyOf: Array.isArray(inner.anyOf)
    ? [...(inner.anyOf as JsonSchema[]), { type: "null" }]
    : [inner, { type: "null" }],
});

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNumber": {
      const checks = (def.checks as { kind: string }[] | undefined) ?? [];
      return { type: checks.some((c) => c.kind === "int") ? "integer" : "number" };
    }
    case "ZodLiteral": {
      const value = def.value;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new UnsupportedSchemaError("ZodLiteral(no primitivo)");
      }
      return { type: typeof value, enum: [value] };
    }
    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };
    case "ZodArray":
      return { type: "array", items: convert(def.type as z.ZodTypeAny) };
    case "ZodOptional":
      // Fuera de un objeto, "opcional" no tiene forma en el dialecto estricto.
      return convert(def.innerType as z.ZodTypeAny);
    case "ZodEffects": {
      // Sólo refinamientos (no transforman el tipo). Un transform sí cambia
      // la forma de entrada: fuera del subconjunto.
      const effect = def.effect as { type?: string } | undefined;
      if (effect?.type !== "refinement") throw new UnsupportedSchemaError("ZodEffects");
      return convert(def.schema as z.ZodTypeAny);
    }
    case "ZodObject":
      return convertObject(schema as z.ZodObject<z.ZodRawShape>);
    case "ZodDiscriminatedUnion":
      return {
        anyOf: (def.options as z.ZodTypeAny[]).map((o) => convert(o)),
      };
    default:
      throw new UnsupportedSchemaError(String(def.typeName));
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    const inner = convert(field);
    properties[key] = field.isOptional() ? nullable(inner) : inner;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * La raíz de los proveedores estrictos debe ser un `object`, no un `anyOf`.
 * Una unión discriminada (la acción del agente) se APLANA a un sobre: `action`
 * (enum de todos los valores) + la unión de los campos de todas las variantes,
 * cada uno `anyOf[T, null]`. Qué campos exige cada variante lo sigue decidiendo
 * el Zod real (tras `stripNulls`), no este esquema.
 */
function flattenDiscriminatedUnion(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const discriminator = def.discriminator as string;
  const options = def.options as z.ZodObject<z.ZodRawShape>[];

  const discriminatorValues: string[] = [];
  const seen = new Map<string, JsonSchema[]>();
  for (const option of options) {
    const literal = option.shape[discriminator];
    if (!literal || defOf(literal).typeName !== "ZodLiteral") {
      throw new UnsupportedSchemaError("ZodDiscriminatedUnion(discriminador no literal)");
    }
    discriminatorValues.push(String(defOf(literal).value));
    for (const [key, value] of Object.entries(option.shape)) {
      if (key === discriminator) continue;
      const converted = convert(value as z.ZodTypeAny);
      const variants = seen.get(key) ?? [];
      if (!variants.some((v) => JSON.stringify(v) === JSON.stringify(converted))) {
        variants.push(converted);
      }
      seen.set(key, variants);
    }
  }

  const properties: Record<string, JsonSchema> = {
    [discriminator]: { type: "string", enum: discriminatorValues },
  };
  for (const [key, variants] of seen) {
    const merged = variants.length === 1 ? variants[0]! : { anyOf: variants };
    properties[key] = nullable(merged);
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** JSON Schema estricto de la raíz. Lanza `UnsupportedSchemaError` fuera del subconjunto. */
export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  if (def.typeName === "ZodDiscriminatedUnion") {
    return flattenDiscriminatedUnion(schema);
  }
  if (def.typeName === "ZodObject") {
    return convertObject(schema as z.ZodObject<z.ZodRawShape>);
  }
  throw new UnsupportedSchemaError(`raíz ${String(def.typeName)} (se exige objeto)`);
}

/**
 * En modo estricto el proveedor rellena con `null` lo que no aplica. Se
 * elimina antes de validar con el Zod real (donde "ausente" es lo correcto).
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}
