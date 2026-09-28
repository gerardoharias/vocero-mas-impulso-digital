import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { APP_VERSION, resolveBuildCommit } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    // La versión viaja aquí a propósito: confirmar un despliegue tiene que
    // poder hacerse con un `curl`, desde un script o desde la plataforma de
    // hosting, sin abrir la app ni iniciar sesión. Es la única forma de que un
    // pipeline pueda comprobar que el build que subió es el que corre.
    const commit = resolveBuildCommit();
    // 024: ¿arrancó el trabajador del outbox en ESTE proceso? (`instrumentation`
    // lo inicia al boot). Un booleano, sin cifras del negocio: el runbook de
    // despliegue lo comprueba con un `curl`. Se lee del global a propósito para
    // no importar el outbox (y todo lo que arrastra) en el healthcheck.
    const outboxWorker = Boolean(
      (globalThis as { __outboxWorker?: unknown }).__outboxWorker
    );
    return Response.json({
      ok: true,
      version: APP_VERSION,
      ...(commit ? { commit } : {}),
      outbox: { worker: outboxWorker },
    });
  } catch {
    return Response.json(
      { ok: false, error: { code: "db_unavailable", message: "Base de datos no disponible" } },
      { status: 503 }
    );
  }
}
