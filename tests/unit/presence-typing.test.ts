import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Escribiendo…" hacia el contacto (2026-09-21).
 *
 * Hasta ahora el agente in-process no señalaba NADA: el prospecto veía ~6 s de
 * debounce más toda la latencia del modelo en silencio, y luego el mensaje de
 * golpe. La capacidad existía, pero atrapada dentro de un route handler.
 *
 * Lo que se fija aquí: que la llamada a Meta sea UNA sola con leído+escribiendo
 * juntos, y que las guardas corten ANTES de tocar la red — sobre todo la del
 * Laboratorio, que es constitucional.
 */

const mocks = vi.hoisted(() => ({
  graphRequest: vi.fn(async () => ({})),
  getCredentialsByOrg: vi.fn(async () => ({
    phoneNumberId: "PN1",
    token: "tok",
  }) as { phoneNumberId: string; token: string } | null),
  select: vi.fn(),
}));

vi.mock("@/lib/meta/client", () => ({ graphRequest: mocks.graphRequest }));
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: mocks.getCredentialsByOrg,
}));

/** Cadena mínima: el único select del módulo busca el último entrante. */
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy"]) c[m] = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}
let inboundRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => {
      mocks.select(...args);
      return chain(inboundRows);
    },
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, table) =>
        new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }),
    }
  ),
}));

/**
 * Solo los campos que el helper mira. El resto de la fila no interviene, así
 * que se castea en vez de fabricar veinte columnas irrelevantes.
 */
type ConvFixture = Parameters<
  typeof import("@/server/whatsapp/presence").markReadAndTyping
>[0]["conversation"];

function conv(overrides: Partial<Record<string, unknown>> = {}): ConvFixture {
  return {
    id: "cv_1",
    organizationId: "org_1",
    channel: "whatsapp",
    isTest: false,
    aiEnabled: true,
    handoffAt: null,
    ...overrides,
  } as unknown as ConvFixture;
}
const CONV = conv();

async function presence() {
  return await import("@/server/whatsapp/presence");
}

describe("markReadAndTyping — la señal que ve el contacto", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    mocks.graphRequest.mockReset();
    mocks.graphRequest.mockResolvedValue({});
    mocks.getCredentialsByOrg.mockReset();
    mocks.getCredentialsByOrg.mockResolvedValue({
      phoneNumberId: "PN1",
      token: "tok",
    });
    mocks.select.mockReset();
    inboundRows = [];
    (await presence()).__resetPresenceState();
  });

  it("una SOLA llamada marca leído y enciende los puntitos", async () => {
    // Que las dos cosas viajen juntas es el punto entero: los puntitos sobre
    // un mensaje con doble palomita gris se ven raros.
    const { markReadAndTyping } = await presence();

    const r = await markReadAndTyping({
      conversation: CONV,
      waMessageId: "wamid.ABC",
    });

    expect(r).toEqual({ ok: true });
    expect(mocks.graphRequest).toHaveBeenCalledTimes(1);
    const [path, opts] = mocks.graphRequest.mock.calls[0] as unknown as [
      string,
      { body: unknown; token: string },
    ];
    expect(path).toBe("PN1/messages");
    expect(opts.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
      typing_indicator: { type: "text" },
    });
  });

  it("con el wamid dado no cuesta ni una query", async () => {
    const { markReadAndTyping } = await presence();
    await markReadAndTyping({ conversation: CONV, waMessageId: "wamid.ABC" });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("sin wamid lo busca, y sin entrantes no señala nada", async () => {
    const { markReadAndTyping } = await presence();
    inboundRows = [];

    const r = await markReadAndTyping({ conversation: CONV });

    expect(r).toEqual({ ok: false, reason: "no_inbound" });
    expect(mocks.select).toHaveBeenCalled();
    expect(mocks.graphRequest).not.toHaveBeenCalled();
  });
});

describe("markReadAndTyping — las guardas cortan ANTES de la red", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    mocks.graphRequest.mockReset();
    mocks.getCredentialsByOrg.mockReset();
    mocks.getCredentialsByOrg.mockResolvedValue({
      phoneNumberId: "PN1",
      token: "tok",
    });
    inboundRows = [];
    (await presence()).__resetPresenceState();
  });

  it("SANDBOX del Laboratorio: ni Meta ni credenciales (constitucional)", async () => {
    // Una conversación de prueba jamás toca la API real. Y ni siquiera se
    // descifra el secreto: leer credenciales ya es demasiado.
    const { markReadAndTyping } = await presence();

    const r = await markReadAndTyping({
      conversation: conv({ isTest: true }),
      waMessageId: "wamid.ABC",
    });

    expect(r).toEqual({ ok: false, reason: "sandbox" });
    expect(mocks.graphRequest).not.toHaveBeenCalled();
    expect(mocks.getCredentialsByOrg).not.toHaveBeenCalled();
  });

  it.each(["instagram", "messenger"] as const)(
    "canal que no lo soporta (%s): ni una llamada inútil a Graph",
    async (channel) => {
      // Regresión del bug que tenía /api/bot/typing: mandaba el id sintético
      // de IG al phoneNumberId de WhatsApp y Meta lo rechazaba.
      const { markReadAndTyping } = await presence();

      const r = await markReadAndTyping({
        conversation: conv({ channel }),
        waMessageId: "ig_123",
      });

      expect(r).toEqual({ ok: false, reason: "channel_unsupported" });
      expect(mocks.graphRequest).not.toHaveBeenCalled();
      expect(mocks.getCredentialsByOrg).not.toHaveBeenCalled();
    }
  );

  it("con handoff o IA pausada no se le miente al cliente", async () => {
    const { markReadAndTyping } = await presence();

    for (const c of [
      conv({ handoffAt: new Date() }),
      conv({ aiEnabled: false }),
    ]) {
      const r = await markReadAndTyping({ conversation: c, waMessageId: "w" });
      expect(r).toEqual({ ok: false, reason: "ai_paused" });
    }
    expect(mocks.graphRequest).not.toHaveBeenCalled();
  });

  it("sin WhatsApp conectado no se inventa una señal", async () => {
    mocks.getCredentialsByOrg.mockResolvedValue(null);
    const { markReadAndTyping } = await presence();

    const r = await markReadAndTyping({ conversation: CONV, waMessageId: "w" });

    expect(r).toEqual({ ok: false, reason: "no_connection" });
    expect(mocks.graphRequest).not.toHaveBeenCalled();
  });

  it("Meta caído: NO lanza, y no reintenta", async () => {
    mocks.graphRequest.mockRejectedValue(new Error("boom"));
    const { markReadAndTyping } = await presence();

    const r = await markReadAndTyping({ conversation: CONV, waMessageId: "w" });

    expect(r).toEqual({ ok: false, reason: "meta_error" });
    expect(mocks.graphRequest).toHaveBeenCalledTimes(1);
  });
});

describe("markReadAndTyping — el estrangulador", () => {
  beforeEach(async () => {
    mocks.graphRequest.mockReset();
    mocks.graphRequest.mockResolvedValue({});
    mocks.getCredentialsByOrg.mockReset();
    mocks.getCredentialsByOrg.mockResolvedValue({
      phoneNumberId: "PN1",
      token: "tok",
    });
    (await presence()).__resetPresenceState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
  });

  it("una ráfaga de mensajes no es una ráfaga de llamadas a Meta", async () => {
    const { markReadAndTyping } = await presence();

    for (let i = 0; i < 4; i++) {
      await markReadAndTyping({
        conversation: CONV,
        waMessageId: `w${i}`,
        minIntervalMs: 10_000,
      });
    }

    expect(mocks.graphRequest).toHaveBeenCalledTimes(1);
  });

  it("pasado el TTL sí se re-enciende: el indicador de Meta ya caducó", async () => {
    const { markReadAndTyping, TYPING_TTL_MS } = await presence();

    await markReadAndTyping({ conversation: CONV, waMessageId: "w1" });
    vi.setSystemTime(new Date(Date.now() + TYPING_TTL_MS + 1_000));
    await markReadAndTyping({
      conversation: CONV,
      waMessageId: "w2",
      minIntervalMs: TYPING_TTL_MS,
    });

    expect(mocks.graphRequest).toHaveBeenCalledTimes(2);
  });
});
