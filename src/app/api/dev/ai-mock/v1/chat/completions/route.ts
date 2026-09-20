import { mockGuard } from "@/lib/dev-guard";
import { aiMockCompletion } from "@/server/dev/ai-mock";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  // Sentinel para el self-test: valida el flujo de "credenciales rechazadas"
  // (contrato ai.md) sin depender de un token real.
  if (req.headers.get("authorization") === "Bearer token-invalido") {
    return Response.json(
      { error: { message: "Invalid API key" } },
      { status: 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    messages?: { role: string; content: unknown }[];
    response_format?: unknown;
  };

  // Sentinel: caída REAL del proveedor. A diferencia de "prosa:", aquí no hay
  // NADA que rescatar, así que el turno debe escalar — pero avisando al
  // cliente, que es lo que antes no pasaba.
  if (JSON.stringify(body.messages ?? []).includes("caida-del-proveedor")) {
    return new Response("boom", { status: 500 });
  }

  // Sentinel: modelo que no soporta el modo JSON. Ejercita el fallback
  // automático de callProvider (reintentar sin response_format y recordarlo).
  if (body.response_format && (body.model ?? "").includes("sin-json")) {
    return Response.json(
      { error: { message: "No endpoints found that support JSON mode" } },
      { status: 404 }
    );
  }

  const content = aiMockCompletion(body.messages ?? []);
  return Response.json({
    id: "aimock",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  });
}
