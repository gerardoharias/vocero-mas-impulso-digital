import { describe, expect, it } from "vitest";
import { harness } from "./setup";

/**
 * CI / desarrollo — el arnés de integración NO puede llegar a Meta ni a
 * OpenRouter (ni a ningún host que no sea loopback), aunque una prueba futura se
 * equivoque de mock. `setup.ts` reemplaza `fetch` por una guardia; esto la prueba.
 */

describe("aislamiento de red del arnés de integración", () => {
  it.each([
    "https://graph.facebook.com/v25.0/123/messages",
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.zoom.us/v2/users/me",
    "https://www.googleapis.com/calendar/v3/calendars",
    "http://169.254.169.254/latest/meta-data/",
  ])("bloquea %s antes de salir de la máquina", async (url) => {
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow(/red externa bloqueada/);
  });

  it("bloquea también cuando el destino llega como URL o Request", async () => {
    await expect(fetch(new URL("https://graph.facebook.com/x"))).rejects.toThrow(/bloqueada/);
    await expect(fetch(new Request("https://openrouter.ai/x"))).rejects.toThrow(/bloqueada/);
  });

  it("no bloquea el loopback (la BD y los servidores locales de prueba siguen funcionando)", async () => {
    // Puerto 9 (discard): rechaza la conexión. Lo que importa es que el error NO sea el de la guardia.
    const err = await fetch("http://127.0.0.1:9/").catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/red externa bloqueada/);
  });

  it("Meta y la IA están simulados: ninguna llamada real quedó registrada", () => {
    expect(harness.meta.calls).toHaveLength(0);
    expect(harness.ai.calls).toBe(0);
  });
});
