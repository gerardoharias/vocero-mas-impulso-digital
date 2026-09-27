/**
 * Verificación contra Postgres REAL del estado de fallos de IA (spec 023 §3.6):
 * migración 0022, atomicidad del incremento bajo concurrencia, ventana de
 * tiempo y reinicio. Usa una conversación existente y la deja como estaba.
 *
 *   docker start vocero-dev-pg
 *   pnpm exec tsx --env-file=.env scripts/verify-ai-fail-state.ts
 *
 * (Requiere haber corrido antes `pnpm db:migrate` y tener al menos una
 * conversación — p. ej. tras `pnpm test:e2e`.)
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../src/lib/db";
import {
  FAILURE_WINDOW_MS,
  recordFormatFailure,
  resetFailureState,
} from "../src/server/ai/failure-state";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${!cond && extra ? ` — ${extra}` : ""}`);
}

async function main() {
  const db = getDb();

  console.log("== migración 0022 ==");
  const cols = await db.execute(
    sql`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'conversation' AND column_name IN ('ai_fail_count','ai_fail_kind','ai_fail_at')
        ORDER BY column_name`
  );
  const byName = new Map(
    (cols as unknown as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]).map(
      (r) => [r.column_name, r]
    )
  );
  check("ai_fail_count integer NOT NULL DEFAULT 0", byName.get("ai_fail_count")?.data_type === "integer" && byName.get("ai_fail_count")?.is_nullable === "NO" && byName.get("ai_fail_count")?.column_default === "0");
  check("ai_fail_kind text NULL", byName.get("ai_fail_kind")?.data_type === "text" && byName.get("ai_fail_kind")?.is_nullable === "YES");
  check("ai_fail_at timestamp NULL", byName.get("ai_fail_at")?.data_type?.startsWith("timestamp") === true && byName.get("ai_fail_at")?.is_nullable === "YES");

  const rows = await db
    .select({ id: schema.conversation.id, organizationId: schema.conversation.organizationId })
    .from(schema.conversation)
    .limit(1);
  const conv = rows[0];
  if (!conv) {
    console.log("  (sin conversaciones: corre pnpm test:e2e primero)");
    process.exit(1);
  }
  const read = async () =>
    (
      await db
        .select({
          count: schema.conversation.aiFailCount,
          kind: schema.conversation.aiFailKind,
          at: schema.conversation.aiFailAt,
        })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, conv.id))
    )[0]!;

  try {
    await resetFailureState(conv);

    console.log("== atomicidad: 25 fallos CONCURRENTES ==");
    const results = await Promise.all(
      Array.from({ length: 25 }, () => recordFormatFailure(conv, "invalid_schema"))
    );
    const sorted = [...results].sort((a, b) => a - b);
    check(
      "cada llamada obtuvo un conteo distinto: exactamente 1..25 (sin pérdidas ni repetidos)",
      sorted.every((v, i) => v === i + 1),
      JSON.stringify(sorted)
    );
    const afterConcurrent = await read();
    check("el contador final es 25", afterConcurrent.count === 25, String(afterConcurrent.count));
    check("guarda el tipo y el momento del último fallo", afterConcurrent.kind === "invalid_schema" && afterConcurrent.at instanceof Date);

    console.log("== ventana de tiempo ==");
    await db
      .update(schema.conversation)
      .set({ aiFailAt: new Date(Date.now() - FAILURE_WINDOW_MS - 60_000) })
      .where(eq(schema.conversation.id, conv.id));
    check("un fallo más viejo que la ventana reinicia en 1", (await recordFormatFailure(conv, "invalid_json")) === 1);
    check("y el siguiente ya es consecutivo: 2", (await recordFormatFailure(conv, "invalid_json")) === 2);

    console.log("== reinicio ==");
    await resetFailureState(conv);
    const reset = await read();
    check("reset: 0, sin tipo, sin fecha", reset.count === 0 && reset.kind === null && reset.at === null);
    check("tras el reset el siguiente fallo vuelve a ser el 1º", (await recordFormatFailure(conv, "invalid_json")) === 1);

    console.log("== aislamiento por organización ==");
    const other = await recordFormatFailure({ id: conv.id, organizationId: "org_inexistente" }, "invalid_json");
    check("otra organización NO puede tocar el contador (no hay fila: devuelve 1 sin alterar)", other === 1 && (await read()).count === 1);
  } finally {
    await resetFailureState(conv);
  }

  console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
