import { mockGuard } from "@/lib/dev-guard";
import {
  googleMockSnapshot,
  googleMockState,
  mockRefreshTokenIsBad,
  resetGoogleMock,
} from "@/server/dev/google-mock-state";

export const dynamic = "force-dynamic";

/**
 * 015 — Google de mentira para el self-test, tras `mockGuard()` (404
 * incondicional en producción).
 *
 * Cubre lo que el conector usa: refrescar el token, crear/leer/mover/borrar un
 * evento y listar eventos (la prueba de conexión). Y reproduce la asincronía
 * de la conferencia: al crear NO hay enlace de Meet, y aparece en una lectura
 * posterior.
 */

type Ctx = { params: Promise<{ path: string[] }> };

const TOKEN = "google-token-de-mentira";

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "token") {
    const body = await req.text();
    if (mockRefreshTokenIsBad(body)) {
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 }
      );
    }
    return Response.json({ access_token: TOKEN, expires_in: 3600 });
  }

  if (route === "_reset") {
    resetGoogleMock();
    return Response.json({ ok: true });
  }

  // POST /calendars/{id}/events
  if (path[0] === "calendars" && path[2] === "events" && path.length === 3) {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;

    const body = (await req.json().catch(() => ({}))) as {
      summary?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    };
    const state = googleMockState();
    const id = `evt_${state.nextId++}`;
    state.events.set(id, {
      id,
      summary: body.summary ?? "",
      start: body.start?.dateTime ?? "",
      end: body.end?.dateTime ?? "",
      reads: 0,
      meetLink: null,
      updates: 0,
    });
    // Sin enlace todavía: la conferencia se está creando. Es el
    // comportamiento real de Google y por eso el conector re-lee.
    return Response.json({
      id,
      summary: body.summary,
      conferenceData: { createRequest: { status: { statusCode: "pending" } } },
    });
  }

  return new Response(null, { status: 404 });
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;

  if (path.join("/") === "_state") return Response.json(googleMockSnapshot());

  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  // GET /calendars/{id} — calendars.get. Un token emitido con `calendar.events`
  // (el scope que pide el conector) NO lo autoriza: Google responde 403. El
  // mock lo reproduce a propósito, para que nadie vuelva a apoyar la prueba de
  // conexión en este endpoint sin que el self-test se ponga rojo.
  if (path[0] === "calendars" && path.length === 2) {
    return Response.json(
      {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            },
          ],
        },
      },
      { status: 403 }
    );
  }

  // GET /calendars/{id}/events — events.list, la prueba de conexión. Sí está
  // cubierta por `calendar.events`, y trae el título del calendario.
  if (path[0] === "calendars" && path[2] === "events" && path.length === 3) {
    const state = googleMockState();
    return Response.json({
      summary: "Calendario de prueba",
      items: [...state.events.values()].slice(0, 1).map((e) => ({ id: e.id })),
    });
  }

  // GET /calendars/{id}/events/{eventId}
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const state = googleMockState();
  event.reads += 1;
  if (!event.meetLink && event.reads > state.conferenceDelayReads) {
    event.meetLink = `https://meet.google.mock/${event.id}`;
  }

  return Response.json({
    id: event.id,
    summary: event.summary,
    conferenceData: event.meetLink
      ? {
          createRequest: { status: { statusCode: "success" } },
          entryPoints: [{ entryPointType: "video", uri: event.meetLink }],
        }
      : { createRequest: { status: { statusCode: "pending" } } },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  };
  if (body.start?.dateTime) event.start = body.start.dateTime;
  if (body.end?.dateTime) event.end = body.end.dateTime;
  event.updates += 1;
  // El evento se movió: su enlace de Meet es el mismo.
  return Response.json({ id: event.id });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const state = googleMockState();
  state.events.delete(event.id);
  state.deleted.push(event.id);
  return new Response(null, { status: 204 });
}

function eventFrom(path: string[]) {
  if (path[0] !== "calendars" || path[2] !== "events" || !path[3]) return null;
  return googleMockState().events.get(path[3]) ?? null;
}

function requireToken(req: Request): Response | null {
  if (req.headers.get("authorization") === `Bearer ${TOKEN}`) return null;
  return Response.json(
    { error: { code: 401, message: "Invalid Credentials" } },
    { status: 401 }
  );
}
