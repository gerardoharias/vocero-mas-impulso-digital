import { mockGuard } from "@/lib/dev-guard";
import { aiMockStats, resetAiMockStats } from "@/server/dev/ai-mock";

export const dynamic = "force-dynamic";

/** 023: cuántas llamadas recibió el ai-mock — el self-test lo usa para afirmar "no 3 cargos". */
export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  return Response.json(aiMockStats());
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  resetAiMockStats();
  return Response.json({ cleared: true });
}
