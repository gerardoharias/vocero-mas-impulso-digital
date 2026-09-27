#!/usr/bin/env node
/**
 * CI — las migraciones de `drizzle/` aplican de cero sobre una base TEMPORAL y
 * aislada, con el mismo script que corre el contenedor al arrancar
 * (`scripts/migrate.mjs`), y volver a aplicarlas no rompe nada (seeds y
 * migraciones re-ejecutables — constitución IV).
 *
 * Crea `vocero_ci_migrate_<rand>` en el servidor de `DATABASE_URL` (no toca la
 * base de esa URL) y la borra al terminar, pase lo que pase. No usa secretos.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const base = process.env.DATABASE_URL;
if (!base) {
  console.error("[ci-migrate] DATABASE_URL no está definida");
  process.exit(1);
}

const name = `vocero_ci_migrate_${randomBytes(4).toString("hex")}`;
const adminUrl = new URL(base);
const tempUrl = new URL(base);
tempUrl.pathname = `/${name}`;

const admin = postgres(adminUrl.href, { max: 1, onnotice: () => {} });
let failure = null;

function runMigrate() {
  const r = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    env: { ...process.env, DATABASE_URL: tempUrl.href, MIGRATIONS_DIR: "drizzle" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`migrate.mjs terminó con ${r.status}\n${r.stdout}\n${r.stderr}`);
}

/**
 * Los `when` del journal tienen que crecer con el `idx`.
 *
 * No es cosmético: `migrate()` compara cada migración contra la ÚLTIMA
 * aplicada (`created_at`) y sólo corre las de `when` MAYOR. Una migración con
 * timestamp anterior al de una ya aplicada se SALTA EN SILENCIO — el script
 * dice "migraciones aplicadas" y la columna nunca existe.
 *
 * Pasa al mezclar una rama de upstream: sus migraciones nacieron antes que las
 * nuestras y, renumeradas a secas, quedan por detrás. Comprobado el 2026-09-27
 * con un merge real: tres migraciones se saltaron sin un solo error.
 */
function checkJournalMonotonic() {
  const j = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const entries = [...j.entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.when <= prev.when) {
      throw new Error(
        `${cur.tag} (when=${cur.when}) NO es posterior a ${prev.tag} (when=${prev.when}): ` +
          `drizzle la saltaría en silencio en cualquier base que ya tenga la anterior. ` +
          `Renumera la migración y dale un \`when\` mayor.`
      );
    }
  }
  console.log(`[ci-migrate] ✓ el journal es monótono (${entries.length} migraciones)`);
}

try {
  checkJournalMonotonic();
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  runMigrate();
  runMigrate(); // re-ejecutable

  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const expected = journal.entries.length;
  const db = postgres(tempUrl.href, { max: 1, onnotice: () => {} });
  try {
    const applied = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    if (applied[0].n !== expected) {
      throw new Error(`se aplicaron ${applied[0].n} migraciones; el journal declara ${expected}`);
    }
    // Lo que introdujo la migración de la spec 024 tiene que existir.
    const t = await db`SELECT to_regclass('public.message_delivery_attempt') AS t`;
    if (!t[0].t) throw new Error("falta la tabla message_delivery_attempt (spec 024)");
    console.log(`[ci-migrate] ✓ ${expected} migraciones aplicadas de cero y re-ejecutadas sin error (${name})`);
  } finally {
    await db.end();
  }
} catch (err) {
  failure = err;
} finally {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  await admin.end();
}

if (failure) {
  console.error(`[ci-migrate] ✗ ${failure.message}`);
  process.exit(1);
}
