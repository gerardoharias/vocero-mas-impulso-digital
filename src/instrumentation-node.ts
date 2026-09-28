import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { startPendingMessageSweeper } from "@/server/inbox/sweeper";
import { startOutboxWorker } from "@/server/outbox";

/** Corridas del Laboratorio que quedaron "running" tras un reinicio → fallidas. */
async function cleanupOrphanRuns(): Promise<void> {
  try {
    const db = getDb();
    const updated = await db
      .update(schema.agentTestRun)
      .set({
        status: "failed",
        error: "Interrumpida por un reinicio del servidor",
        finishedAt: new Date(),
      })
      .where(eq(schema.agentTestRun.status, "running"))
      .returning({ id: schema.agentTestRun.id });
    if (updated.length > 0) {
      console.log(
        `[boot] ${updated.length} corrida(s) del Laboratorio huérfana(s) marcada(s) como fallida(s)`
      );
    }
  } catch (err) {
    // La BD puede no estar lista aún (migraciones corren antes del server).
    console.error("[boot] limpieza de corridas huérfanas falló:", err);
  }
}

/**
 * Tareas de arranque del runtime Node (FR-034 + sweeper de mensajes colgados +
 * trabajador del outbox, spec 024: reanuda los reintentos que dejó un reinicio).
 */
export async function runBootTasks(): Promise<void> {
  await cleanupOrphanRuns();
  startPendingMessageSweeper();
  startOutboxWorker();
}
