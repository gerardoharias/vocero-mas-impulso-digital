/**
 * Caso AISLADO de `offer_slots` (agente real: inbound → coalesce → pipeline →
 * ai-mock → offerSlots → wa-mock) medido desde un ARRANQUE EN FRÍO.
 *
 * Existe porque en la corrida completa del E2E, en frío, el check
 * «Max respondió ofreciendo horarios» falló 3 veces tras una espera fija de
 * 9 s (AGENT_COALESCE_MS + 3 s): el mensaje sí llegó, más tarde. Esto mide
 * cuánto tarda de verdad y QUÉ se compila mientras tanto.
 *
 * Uso (BD migrada y .env con los mocks; el puerto 3000 debe estar libre):
 *   node --env-file=.env scripts/e2e-offer-slots-cold.mjs --cold 5
 *   node --env-file=.env scripts/e2e-offer-slots-cold.mjs --cold 3 --wipe-next
 *   node --env-file=.env scripts/e2e-offer-slots-cold.mjs --once      # contra un servidor ya vivo
 *
 * --cold N       N iteraciones; cada una arranca `pnpm dev` NUEVO y lo mata al terminar
 * --wipe-next    además borra `.next` antes de cada arranque (frío absoluto)
 * --then-warm   tras la pasada en frío, repite el escenario en el MISMO servidor (línea base caliente)
 * --fixed-ms M   la espera fija que se está evaluando (default AGENT_COALESCE_MS + 3000)
 * El check espera una CONDICIÓN observable (el mensaje en el outbox), con tope de 120 s.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-E2E-1";
const COALESCE_MS = Number(process.env.AGENT_COALESCE_MS ?? 6000);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const COLD = flag("--cold") ? Number(val("--cold", "3")) : 0;
const FIXED_MS = Number(val("--fixed-ms", String(COALESCE_MS + 3000)));
const WIPE = flag("--wipe-next");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { value: null, ms: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

/** Una pasada del escenario contra el servidor que esté vivo. */
async function scenario(logFile) {
  const out = {};
  const t0 = Date.now();
  let su = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: "e2e@vocero.test", password: "password-e2e-123" }),
  });
  if (!su.res.ok) {
    su = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" }),
    });
  }
  if (!su.res.ok) throw new Error(`login falló: ${su.res.status}`);
  await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" }),
  });
  const day = [{ start: "09:00", end: "18:00" }];
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({
      weeklyHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: "https://meet.ejemplo.test/sala-fija",
    }),
  });
  await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });
  out.setupMs = Date.now() - t0;

  const run = String(Date.now()).slice(-8);
  const from = `52146${run}`;
  const to = from.replace(/^521/, "52");
  const logBefore = existsSync(logFile) ? statSync(logFile).size : 0;

  const tInbound = Date.now();
  const inb = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from,
      name: `Lead offer_slots ${run}`,
      text: "quiero agendar una cita",
      waMessageId: `wamid.cold.${run}`,
    }),
  });
  out.inboundPostMs = Date.now() - tInbound;
  if (!inb.res.ok) throw new Error(`inbound falló: ${inb.res.status}`);
  const tAfterPost = Date.now();

  const got = await waitFor(async () => {
    const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
    return outbox.find((o) => o.to === to && typeof o.body?.text?.body === "string") ?? null;
  });
  out.arrived = Boolean(got.value);
  out.msFromInbound = got.ms + (tAfterPost - tInbound);
  out.overheadOverCoalesceMs = out.msFromInbound - COALESCE_MS;
  out.fixedWaitWouldPass = out.arrived && out.msFromInbound <= FIXED_MS;
  const text = got.value?.body?.text?.body ?? "";
  const lines = text.split("\n").filter((l) => l.startsWith("• "));
  out.options = lines.length;
  out.distinctDays = new Set(lines.map((l) => l.split(" a las ")[0])).size;

  // Qué se compiló / qué hizo el agente durante la espera (log del servidor).
  if (existsSync(logFile)) {
    const fresh = readFileSync(logFile, "utf-8").slice(logBefore);
    out.compiledDuringWait = [...fresh.matchAll(/Compiled (\S+) in ([\d.]+)(ms|s)/g)].map((m) => ({
      route: m[1],
      ms: Math.round(Number(m[2]) * (m[3] === "s" ? 1000 : 1)),
    }));
  }
  await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  return out;
}

function killTree(child) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-child.pid);
  } catch {}
}

async function healthy() {
  try {
    return (await fetch(`${BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function coldIteration(i) {
  if (await healthy()) throw new Error("el puerto 3000 ya tiene un servidor vivo: páralo primero");
  if (WIPE) rmSync(".next", { recursive: true, force: true });
  const dir = path.join(tmpdir(), "vocero-cold");
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `dev-${i}.log`);
  rmSync(logFile, { force: true });
  const fd = openSync(logFile, "w");
  const tSpawn = Date.now();
  const child = spawn("pnpm", ["dev"], { shell: true, stdio: ["ignore", fd, fd], detached: process.platform !== "win32" });
  try {
    const ready = await waitFor(healthy, { timeoutMs: 180_000, intervalMs: 300 });
    if (!ready.value) throw new Error("el servidor no llegó a healthy");
    const serverReadyMs = Date.now() - tSpawn;
    cookie = "";
    const r = await scenario(logFile);
    // Línea base CALIENTE: el mismo servidor, ya compilado, otro prospecto.
    const warm = flag("--then-warm") ? await scenario(logFile) : null;
    return { i, serverReadyMs, ...r, warm };
  } finally {
    killTree(child);
    closeSync(fd);
    for (let k = 0; k < 40 && (await healthy()); k++) await sleep(250);
  }
}

const stats = (xs) => ({
  min: Math.min(...xs),
  avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
  max: Math.max(...xs),
});

async function main() {
  const results = [];
  if (COLD > 0) {
    for (let i = 1; i <= COLD; i++) {
      console.log(`\n── arranque en frío ${i}/${COLD}${WIPE ? " (con .next borrado)" : ""} ──`);
      const r = await coldIteration(i);
      results.push(r);
      console.log(JSON.stringify(r, null, 2));
    }
  } else {
    const r = await scenario(path.join(tmpdir(), "no-log"));
    results.push({ i: 1, ...r });
    console.log(JSON.stringify(r, null, 2));
  }

  const ok = results.filter((r) => r.arrived);
  console.log(`\n══ RESUMEN (${results.length} corridas, coalesce=${COALESCE_MS} ms, espera fija evaluada=${FIXED_MS} ms) ══`);
  console.log(`llegó el mensaje:            ${ok.length}/${results.length}`);
  if (ok.length) {
    const t = stats(ok.map((r) => r.msFromInbound));
    console.log(`inbound → mensaje (ms):      min ${t.min} · prom ${t.avg} · máx ${t.max}`);
    const o = stats(ok.map((r) => r.overheadOverCoalesceMs));
    console.log(`sobrecosto sobre coalesce:   min ${o.min} · prom ${o.avg} · máx ${o.max}`);
    console.log(`habría pasado la espera fija de ${FIXED_MS} ms: ${ok.filter((r) => r.fixedWaitWouldPass).length}/${results.length}`);
    console.log(`opciones de horario / días distintos (mín): ${Math.min(...ok.map((r) => r.options))} / ${Math.min(...ok.map((r) => r.distinctDays))}`);
  }
  const warms = results.map((r) => r.warm).filter((w) => w?.arrived);
  if (warms.length) {
    const w = stats(warms.map((x) => x.msFromInbound));
    console.log(`CALIENTE inbound → mensaje:  min ${w.min} · prom ${w.avg} · máx ${w.max}  (${warms.length} corridas)`);
  }
  if (COLD > 0) {
    const s = stats(results.map((r) => r.serverReadyMs));
    console.log(`servidor listo (ms):         min ${s.min} · prom ${s.avg} · máx ${s.max}`);
  }
  process.exit(ok.length === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("error:", e instanceof Error ? e.message : e);
  process.exit(2);
});
