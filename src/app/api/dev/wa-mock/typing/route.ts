import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * Las señales de presencia (leído + "escribiendo…") que el CRM le mandó al
 * mock. Existe para que el self-test pueda afirmar que el prospecto SÍ vio los
 * tres puntitos, y con qué mensaje — antes el mock respondía {success:true} y
 * no quedaba rastro de nada.
 */
export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  return Response.json({ typingSignals: getWaMockState().typingSignals });
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  getWaMockState().typingSignals.length = 0;
  return Response.json({ cleared: true });
}
