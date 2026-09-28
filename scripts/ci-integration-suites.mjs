#!/usr/bin/env node
/**
 * CI — las suites de integración (Postgres real) de las specs 024, 025 y 026.
 *
 * Existe para que una suite NO pueda desaparecer en silencio: que un archivo se
 * renombre, quede en `.skip` o deje de coincidir con el filtro del paso de CI no
 * puede volver el pipeline verde por accidente.
 *
 *   node scripts/ci-integration-suites.mjs filters <grupo>            # patrones para vitest
 *   node scripts/ci-integration-suites.mjs verify  <grupo> <reporte>  # verifica el JSON de vitest
 *   node scripts/ci-integration-suites.mjs coverage                   # todo archivo está en algún grupo
 *
 * Sale distinto de cero ante cualquier incumplimiento. No lee secretos ni red.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Cada grupo: los archivos que DEBEN correr (y pasar) y el filtro con que se seleccionan. */
export const GROUPS = {
  "024": {
    title: "spec 024 · entrega íntegra de mensajes salientes",
    filters: ["outbound-", "bot-send-contract"],
    files: [
      "outbound-incident.test.ts",
      "outbound-diagnosis.test.ts",
      "outbound-delivery.test.ts",
      "outbound-migration.test.ts",
      "outbound-offer-guard.test.ts",
      "outbound-reoffer.test.ts",
      "bot-send-contract.test.ts",
    ],
  },
  "025": {
    title: "spec 025 · consultas de disponibilidad del calendario",
    filters: ["availability-"],
    files: ["availability-diagnosis.test.ts", "availability-query.test.ts", "availability-guard.test.ts"],
  },
  "026": {
    title: "spec 026 · aclaraciones de disponibilidad del calendario",
    filters: ["agenda-clarify"],
    files: ["agenda-clarify.test.ts"],
  },
  aislamiento: {
    title: "aislamiento de red del arnés (ni Meta ni OpenRouter reales)",
    filters: ["network-isolation"],
    files: ["network-isolation.test.ts"],
  },
};

const DIR = path.join(process.cwd(), "tests", "integration");
const [cmd, group, report] = process.argv.slice(2);

function fail(msg) {
  console.error(`[ci-integration] ✗ ${msg}`);
  process.exit(1);
}

if (cmd === "filters") {
  const g = GROUPS[group];
  if (!g) fail(`grupo desconocido: ${group}`);
  process.stdout.write(g.filters.join(" "));
} else if (cmd === "coverage") {
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".test.ts")).sort();
  const declared = Object.values(GROUPS).flatMap((g) => g.files).sort();
  const missingOnDisk = declared.filter((f) => !onDisk.includes(f));
  const undeclared = onDisk.filter((f) => !declared.includes(f));
  if (missingOnDisk.length) fail(`suites declaradas que NO existen: ${missingOnDisk.join(", ")}`);
  if (undeclared.length) {
    fail(
      `suites de integración sin grupo (no correrían en CI): ${undeclared.join(", ")} — ` +
        "agrégalas a GROUPS en scripts/ci-integration-suites.mjs"
    );
  }
  console.log(`[ci-integration] ✓ ${onDisk.length} suites, todas asignadas a un grupo`);
} else if (cmd === "verify") {
  const g = GROUPS[group];
  if (!g) fail(`grupo desconocido: ${group}`);
  if (!report || !existsSync(report)) fail(`no hay reporte de vitest en «${report}» (¿la corrida no llegó a terminar?)`);
  const data = JSON.parse(readFileSync(report, "utf8"));

  if (data.numFailedTests > 0) fail(`${data.numFailedTests} prueba(s) fallaron`);
  if (data.numFailedTestSuites > 0) fail(`${data.numFailedTestSuites} suite(s) fallaron al cargar o en un hook`);
  if (data.numPendingTests > 0) fail(`${data.numPendingTests} prueba(s) omitidas (skip/todo): en CI no se omite nada`);
  if (!data.numPassedTests) fail("no se ejecutó ninguna prueba");

  const byName = new Map(
    (data.testResults ?? []).map((r) => [path.basename(String(r.name)), r])
  );
  for (const file of g.files) {
    const r = byName.get(file);
    if (!r) fail(`la suite «${file}» NO corrió (¿cambió el filtro o el nombre?)`);
    if (r.status !== "passed") fail(`la suite «${file}» terminó en «${r.status}»`);
    const n = (r.assertionResults ?? []).filter((a) => a.status === "passed").length;
    if (n === 0) fail(`la suite «${file}» no ejecutó ninguna prueba`);
  }
  const unexpected = [...byName.keys()].filter((f) => !g.files.includes(f));
  if (unexpected.length) fail(`corrieron suites ajenas al grupo ${group}: ${unexpected.join(", ")}`);

  console.log(
    `[ci-integration] ✓ ${g.title}: ${g.files.length} suites, ${data.numPassedTests} pruebas, 0 fallos, 0 omitidas`
  );
} else {
  fail("uso: filters <grupo> | verify <grupo> <reporte.json> | coverage");
}
