import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState } from "@/server/dev/wa-mock-state";

/**
 * 024 — Guioniza los RECHAZOS de los próximos envíos de mensaje del wa-mock
 * (sólo dev/test, tras `mockGuard`: 404 en producción). Cada entrada se
 * consume en un `POST /messages`; sin `code`, la respuesta no trae cuerpo de
 * Meta (resultado ambiguo, como un 502 de un proxy).
 *
 *   POST   { "failures": [{ "status": 503, "code": 2 }] }
 *   DELETE (vacía la cola)
 */
export const dynamic = "force-dynamic";

const body = z.object({
  failures: z
    .array(
      z.object({
        status: z.number().int().min(400).max(599),
        code: z.number().int().optional(),
        subcode: z.number().int().optional(),
      })
    )
    .min(1)
    .max(10),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "failures inválido" }, { status: 400 });
  }
  const state = getWaMockState();
  state.failNext.push(...parsed.data.failures);
  return Response.json({ queued: state.failNext.length });
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  getWaMockState().failNext.length = 0;
  return Response.json({ cleared: true });
}
