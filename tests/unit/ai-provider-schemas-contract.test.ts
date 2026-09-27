import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UnsupportedSchemaError, zodToStrictJsonSchema } from "@/lib/ai/json-schema";
import { PROVIDER_SCHEMAS } from "@/server/ai/schemas";

/**
 * Prueba de CONTRATO del conversor Zod → JSON Schema (spec 023 §3.9).
 *
 * Recorre TODOS los esquemas que hoy se le mandan al proveedor y comprueba que
 * (a) el conversor los acepta y (b) el resultado cumple el dialecto estricto.
 * Además escanea el código: una llamada nueva a `chatJson` con un `schemaName`
 * fuera de `PROVIDER_SCHEMAS` rompe el CI — la incompatibilidad se descubre
 * aquí, no la primera vez que escribe un prospecto.
 */

type Node = Record<string, unknown>;

/** Palabras clave que el dialecto estricto no admite (o no en todos los proveedores). */
const FORBIDDEN_KEYS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "default",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "patternProperties",
];

function assertStrictNode(node: Node, where: string): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(node, `${where}: no debe llevar '${key}'`).not.toHaveProperty(key);
  }
  if (node.type === "object") {
    const props = node.properties as Record<string, Node>;
    expect(node.additionalProperties, `${where}: additionalProperties`).toBe(false);
    expect([...(node.required as string[])].sort(), `${where}: required = todas`).toEqual(
      Object.keys(props).sort()
    );
    for (const [k, v] of Object.entries(props)) assertStrictNode(v, `${where}.${k}`);
  } else if (node.type === "array") {
    assertStrictNode(node.items as Node, `${where}[]`);
  } else if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as Node[];
    expect(branches.length, `${where}: anyOf con ≥ 2 ramas`).toBeGreaterThanOrEqual(2);
    for (const b of branches) {
      expect(b, `${where}: anyOf plano (sin anidar uniones)`).not.toHaveProperty("anyOf");
      assertStrictNode(b, `${where}|`);
    }
  } else if (Array.isArray(node.enum)) {
    expect((node.enum as unknown[]).length, `${where}: enum no vacío`).toBeGreaterThan(0);
  } else {
    expect(
      ["string", "number", "integer", "boolean", "null"],
      `${where}: tipo primitivo conocido`
    ).toContain(node.type);
  }
}

describe("esquemas enviados al proveedor: el conversor los acepta y son estrictos", () => {
  for (const [name, variants] of Object.entries(PROVIDER_SCHEMAS)) {
    for (const { label, schema } of variants) {
      it(`${name} — ${label}`, () => {
        let json: Node | undefined;
        expect(() => {
          json = zodToStrictJsonSchema(schema) as Node;
        }, "el conversor no debe lanzar sobre un esquema real").not.toThrow();
        expect(json!.type, "la raíz debe ser un objeto").toBe("object");
        assertStrictNode(json!, name);
        // y es serializable tal cual viaja en la petición
        expect(() => JSON.stringify(json)).not.toThrow();
        // el nombre exigido por el proveedor
        expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      });
    }
  }
});

describe("cobertura: todo schemaName del código está registrado, y viceversa", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }
  const root = path.resolve(import.meta.dirname, "../../src");
  const files = sourceFiles(root);
  const rel = (f: string) => path.relative(root, f).replace(/\\/g, "/");

  const usedNames = new Map<string, string[]>();
  const callSites: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/schemaName:\s*"([^"]+)"/g)) {
      usedNames.set(m[1]!, [...(usedNames.get(m[1]!) ?? []), rel(file)]);
    }
    // llamadas a chatJson( — excluyendo su definición y los `import`
    if (
      /\bchatJson(<[^>]*>)?\(/.test(text.replace(/export async function chatJson<T>\(/g, "")) &&
      rel(file) !== "lib/ai/index.ts"
    ) {
      callSites.push(rel(file));
    }
  }

  it("todo schemaName usado en src/ existe en PROVIDER_SCHEMAS", () => {
    const registered = new Set(Object.keys(PROVIDER_SCHEMAS));
    for (const [name, where] of usedNames) {
      expect(registered.has(name), `schemaName "${name}" (${where.join(", ")}) sin registrar`).toBe(
        true
      );
    }
  });

  it("todo esquema registrado se usa en algún lugar (no hay entradas huérfanas)", () => {
    for (const name of Object.keys(PROVIDER_SCHEMAS)) {
      expect(usedNames.has(name), `"${name}" está registrado pero ningún código lo usa`).toBe(true);
    }
  });

  it("cada archivo que llama a chatJson declara su schemaName (las llamadas conocidas)", () => {
    // pipeline (agente), recovery (texto plano), judge (juez); transcribeAudio vive en lib/ai/index.ts.
    expect(callSites.sort()).toEqual(
      ["server/ai/pipeline.ts", "server/ai/recovery.ts", "server/lab/judge.ts"].sort()
    );
    for (const site of callSites) {
      const declared = [...usedNames.entries()].some(([, w]) => w.includes(site));
      expect(declared, `${site} llama a chatJson sin schemaName`).toBe(true);
    }
    expect(usedNames.get("transcripcion")).toEqual(["lib/ai/index.ts"]);
  });
});

describe("esquemas futuros desconocidos: fallan en voz alta", () => {
  it("el conversor lanza UnsupportedSchemaError, y chatJson lo degrada a json_object con un warn (ver ai-adapter.test)", async () => {
    const { z } = await import("zod");
    expect(() => zodToStrictJsonSchema(z.object({ x: z.date() }))).toThrow(UnsupportedSchemaError);
    expect(() => zodToStrictJsonSchema(z.object({ x: z.string().nullable() }))).toThrow(
      UnsupportedSchemaError
    );
    expect(() => zodToStrictJsonSchema(z.object({ x: z.string().default("a") }))).toThrow(
      UnsupportedSchemaError
    );
    expect(() => zodToStrictJsonSchema(z.object({ x: z.tuple([z.string()]) }))).toThrow(
      UnsupportedSchemaError
    );
  });
});
