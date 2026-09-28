import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migración 0023 (spec 024) contra Postgres REAL, sobre datos EXISTENTES:
 *  - se aplica hasta la 0022, se siembran filas «de antes», y luego se aplica la 0023;
 *  - lo anterior queda intacto y con el estado correcto por defecto (sin backfill);
 *  - es re-ejecutable (Constitución IV): correrla otra vez no falla ni duplica;
 *  - el trigger hace inmutable el texto de un saliente (G3) sin frenar los estados.
 */

const ROOT = process.cwd();
const DRIZZLE = path.join(ROOT, "drizzle");
const MIGRATION = "0023_entrega_integra_saliente";

let adminUrl = "";
let dbName = "";
let dbUrl = "";
let sql: ReturnType<typeof postgres>;

function urlFor(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Copia de `drizzle/` con el diario recortado a las migraciones ANTERIORES a la 0023. */
function migrationsBefore0023(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vocero-mig-"));
  mkdirSync(path.join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const kept = journal.entries.filter((e) => e.tag !== MIGRATION && e.tag < MIGRATION);
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept })
  );
  for (const e of kept) cpSync(path.join(DRIZZLE, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

beforeAll(async () => {
  const base = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/vocero";
  adminUrl = urlFor(base, "postgres");
  dbName = `vocero_it_mig_${Date.now()}_${randomBytes(3).toString("hex")}`;
  dbUrl = urlFor(base, dbName);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  sql = postgres(dbUrl, { max: 2, onnotice: () => {} });

  // 1) La base «de antes»: migraciones hasta la 0022, con datos.
  await migrate(drizzle(sql), { migrationsFolder: migrationsBefore0023() });
  await sql`insert into organization (id, name, slug) values ('org_old', 'Vieja', 'vieja')`;
  await sql`insert into contact (id, organization_id, wa_identity, name) values ('ct_old', 'org_old', '521', 'Prospecto')`;
  await sql`insert into conversation (id, organization_id, contact_id) values ('cv_old', 'org_old', 'ct_old')`;
  await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status, wa_message_id)
            values ('msg_old_out', 'org_old', 'cv_old', 'out', 'text', 'texto viejo', 'delivered', 'wamid.OLD'),
                   ('msg_old_fail', 'org_old', 'cv_old', 'out', 'text', 'no salió', 'failed', null)`;
  await sql`insert into offered_slot (id, organization_id, conversation_id, start_utc, label)
            values ('ofs_old', 'org_old', 'cv_old', now(), 'mié 16 sep, 09:00')`;

  // 2) La actualización real: se aplica la 0023 sobre esos datos.
  await migrate(drizzle(sql), { migrationsFolder: DRIZZLE });
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
});

describe("migración 0023 sobre datos existentes", () => {
  it("los mensajes de antes quedan intactos, con defaults correctos y sin backfill", async () => {
    const rows = await sql`select id, text, status, wa_message_id, delivery_attempts, next_attempt_at,
                                  locked_until, error_code, error_subcode, error_class, trace_id, dedupe_key, offer_state
                           from message order by id`;
    expect(rows).toHaveLength(2);
    const failed = rows.find((r) => r.id === "msg_old_fail")!;
    expect(failed).toMatchObject({
      text: "no salió",
      status: "failed",
      delivery_attempts: 0,
      next_attempt_at: null,
      dedupe_key: null,
      error_class: null,
      offer_state: null,
    });
    expect(rows.find((r) => r.id === "msg_old_out")).toMatchObject({
      status: "delivered",
      wa_message_id: "wamid.OLD",
      delivery_attempts: 0,
    });
  });

  it("los horarios ya ofrecidos siguen ACTIVOS (seleccionables) y sin mensaje", async () => {
    const rows = await sql`select state, message_id, shown from offered_slot where id = 'ofs_old'`;
    expect(rows[0]).toMatchObject({ state: "active", message_id: null, shown: true });
  });

  it("la tabla de intentos existe, con su unicidad por (mensaje, intento) y tenant NOT NULL", async () => {
    await sql`insert into message_delivery_attempt (id, organization_id, message_id, attempt_no, stage, outcome)
              values ('mda_1', 'org_old', 'msg_old_fail', 1, 'sync', 'started')`;
    await expect(
      sql`insert into message_delivery_attempt (id, organization_id, message_id, attempt_no, stage, outcome)
          values ('mda_2', 'org_old', 'msg_old_fail', 1, 'sync', 'started')`
    ).rejects.toThrow(/duplicate|unique/i);
    await expect(
      sql`insert into message_delivery_attempt (id, message_id, attempt_no, stage, outcome)
          values ('mda_3', 'msg_old_fail', 2, 'sync', 'started')`
    ).rejects.toThrow(/null value|organization_id/i);
  });

  it("dedupe_key es única: la segunda respuesta lógica del mismo turno no se inserta", async () => {
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status, dedupe_key)
              values ('msg_d1', 'org_old', 'cv_old', 'out', 'text', 'a', 'queued', 'agent-turn:msg_x')`;
    const again = await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status, dedupe_key)
              values ('msg_d2', 'org_old', 'cv_old', 'out', 'text', 'b', 'queued', 'agent-turn:msg_x')
              on conflict (dedupe_key) do nothing returning id`;
    expect(again).toHaveLength(0);
    // Varias filas SIN clave conviven (NULL no choca).
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status)
              values ('msg_n1', 'org_old', 'cv_old', 'out', 'text', 'c', 'sent'),
                     ('msg_n2', 'org_old', 'cv_old', 'out', 'text', 'd', 'sent')`;
  });

  it("el texto de un saliente es inmutable en la BASE; el estado y el intento sí avanzan", async () => {
    await expect(
      sql`update message set text = 'reescrito' where id = 'msg_old_fail'`
    ).rejects.toThrow(/inmutable/);
    await sql`update message set status = 'retrying', delivery_attempts = 1, error_class = 'transient'
              where id = 'msg_old_fail'`;
    const [row] = await sql`select text, status from message where id = 'msg_old_fail'`;
    expect(row).toEqual({ text: "no salió", status: "retrying" });
    // Un entrante sí puede corregirse (la inmutabilidad es del payload SALIENTE).
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status)
              values ('msg_in', 'org_old', 'cv_old', 'in', 'text', 'hola', 'delivered')`;
    await sql`update message set text = 'hola!' where id = 'msg_in'`;
  });
});

describe("compatibilidad de la VERSIÓN ANTERIOR con la base migrada (runbook §10)", () => {
  it("su migrador (carpeta sin la 0023) no aplica ni falla sobre la base ya migrada", async () => {
    const before = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await migrate(drizzle(sql), { migrationsFolder: migrationsBefore0023() });
    const after = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(after[0]!.n).toBe(before[0]!.n); // ni aplicó nada ni revirtió nada
    const [col] = await sql`select count(*)::int as n from information_schema.columns
                            where table_name = 'message' and column_name = 'dedupe_key'`;
    expect(col!.n).toBe(1); // las columnas nuevas siguen ahí
  });

  it("los INSERT/UPDATE del código anterior (sin las columnas nuevas) siguen siendo válidos", async () => {
    // persistOutbound de antes: sin delivery_attempts, dedupe_key, offer_state…
    await sql`insert into message (id, organization_id, conversation_id, wa_message_id, direction, type, text, status, ai_generated, origin)
              values ('msg_old_style', 'org_old', 'cv_old', 'wamid.OLDSTYLE', 'out', 'text', 'texto de la versión anterior', 'pending', true, 'ai')`;
    const [row] = await sql`select delivery_attempts, dedupe_key, offer_state, error_class from message where id = 'msg_old_style'`;
    expect(row).toEqual({ delivery_attempts: 0, dedupe_key: null, offer_state: null, error_class: null });

    // Sus acuses y el sweeper de mensajes colgados: UPDATE de status/error sin tocar `text`.
    await sql`update message set status = 'sent' where id = 'msg_old_style' and status = 'pending'`;
    await sql`update message set status = 'failed', error = 'motivo' where id = 'msg_old_style'`;

    // replaceOffers de antes: borra e inserta sin message_id/state/shown → quedan ACTIVAS y mostradas.
    await sql`delete from offered_slot where conversation_id = 'cv_old'`;
    await sql`insert into offered_slot (id, organization_id, conversation_id, start_utc, label)
              values ('ofs_old_style', 'org_old', 'cv_old', now(), 'jue 17 sep, 10:00')`;
    const [offer] = await sql`select state, shown, message_id from offered_slot where id = 'ofs_old_style'`;
    expect(offer).toEqual({ state: "active", shown: true, message_id: null });
  });

  it("una base migrada con mensajes en estados NUEVOS no rompe las lecturas del código anterior", async () => {
    // El código anterior lee `text` de `status` sin enum en la BD: sólo la UI pinta un desconocido como fallo.
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status)
              values ('msg_new_state', 'org_old', 'cv_old', 'out', 'text', 'x', 'retrying')`;
    const rows = await sql`select status from message where id = 'msg_new_state'`;
    expect(rows[0]!.status).toBe("retrying"); // por eso el runbook drena antes de revertir
  });
});

describe("re-ejecutable (Constitución IV)", () => {
  it("correr la 0023 dos veces más no falla ni cambia nada", async () => {
    const source = readFileSync(path.join(DRIZZLE, `${MIGRATION}.sql`), "utf8");
    const statements = source
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const before = await sql`select count(*)::int as n from message`;

    for (let i = 0; i < 2; i++) {
      await sql.begin(async (tx) => {
        for (const st of statements) await tx.unsafe(st);
      });
    }

    const after = await sql`select count(*)::int as n from message`;
    expect(after[0]!.n).toBe(before[0]!.n);
    // Sigue habiendo UN solo trigger y UN solo índice parcial.
    const trg = await sql`select count(*)::int as n from pg_trigger where tgname = 'message_out_text_immutable_trg'`;
    expect(trg[0]!.n).toBe(1);
    const idx = await sql`select count(*)::int as n from pg_indexes where indexname = 'message_outbox_due_idx'`;
    expect(idx[0]!.n).toBe(1);
  });

  it("el índice del barrido es PARCIAL (sólo lo que está en vuelo)", async () => {
    const [row] = await sql`select indexdef from pg_indexes where indexname = 'message_outbox_due_idx'`;
    expect(row!.indexdef).toMatch(/WHERE/i);
    expect(row!.indexdef).toMatch(/queued/);
  });
});
