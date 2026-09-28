import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec 024 G4/G9/G10 — la frontera que hace IMPOSIBLE (no sólo improbable) que
 * un reintento vuelva a llamar al modelo, al pipeline, a `offer_slots`/`book_slot`
 * o a la consulta de disponibilidad: el outbox no los importa.
 */

const OUTBOX_DIR = path.join(process.cwd(), "src", "server", "outbox");

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+["']@\/lib\/ai(\/|["'])/, why: "el modelo de IA (llamadas facturables)" },
  { pattern: /from\s+["']@\/server\/ai(\/|["'])/, why: "el pipeline del agente" },
  { pattern: /from\s+["']@\/server\/agenda\/agent["']/, why: "offer_slots / book_slot" },
  { pattern: /from\s+["']@\/server\/agenda\/availability["']/, why: "la consulta de disponibilidad" },
  { pattern: /from\s+["']@\/server\/agenda\/service["']/, why: "crear/mover citas" },
];

function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gms)].map(
    (m) => m[1]!
  );
}

describe("frontera del outbox", () => {
  const files = readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".ts"));

  it("existe y tiene sus dos piezas", () => {
    expect(files.sort()).toEqual(["index.ts", "policy.ts"]);
  });

  it.each(FORBIDDEN)("no importa $why", ({ pattern }) => {
    for (const f of files) {
      const source = readFileSync(path.join(OUTBOX_DIR, f), "utf8");
      expect(pattern.test(source), `${f} importa algo prohibido: ${pattern}`).toBe(false);
    }
  });

  it("sus imports son sólo de infraestructura de envío (BD, eventos, canal, ofertas)", () => {
    const allowed = [
      "drizzle-orm",
      "@/lib/db",
      "@/lib/db/ids",
      "@/lib/meta/send-errors",
      "@/server/channels/capabilities",
      "@/server/events/bus",
      "@/server/inbox/ingest",
      "@/server/inbox/send",
      "@/server/agenda/offers",
      "@/server/agenda/offer-freshness",
      "@/server/outbox/policy",
    ];
    for (const f of files) {
      const source = readFileSync(path.join(OUTBOX_DIR, f), "utf8");
      for (const imp of importsOf(source)) {
        expect(allowed, `${f} importa «${imp}», fuera de la lista permitida`).toContain(imp);
      }
    }
  });

  it("nada en el código de producción reescribe el texto de un saliente", () => {
    // Complementa al trigger de BD: ninguna ruta hace `.set({ text: … })` sobre `message`.
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(p, "utf8");
          if (/update\(schema\.message\)\s*\.set\(\{[^}]*\btext\s*:/s.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
