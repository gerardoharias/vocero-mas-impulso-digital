/**
 * Self-test E2E de comportamiento — conduce la app real en localhost con los
 * mocks (wa-mock + ai-mock) por las superficies de usuario, en vez de darle
 * el guion al humano. Cubre tests/e2e/us-bsuid.md y tests/e2e/us-bot-api.md.
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      BOT_API_KEY configurada y BD migrada
 *   2) node --env-file=.env scripts/e2e-selftest.mjs
 *
 * Sale con código 1 si algún check falla (apto para CI o para el gate previo
 * a declarar "Hecho").
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  OK  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      // Better Auth valida Origin (CSRF) en los endpoints de auth.
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

function bot(path, opts = {}) {
  return api(path, {
    ...opts,
    headers: { "x-api-key": BOT_KEY ?? "", ...(opts.headers ?? {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PN = "PN-E2E-1";
// wa_message_id es UNIQUE y la ingesta dedupea en silencio (correcto para
// reintentos reales de Meta): en una RE-CORRIDA contra la MISMA base, un
// literal fijo choca con la fila que ya dejó la corrida anterior y el ingest
// se sale antes de tocar lastInboundAt — la ventana de 24h aparece cerrada
// aunque el inbound "acabe de llegar". Un sello por corrida evita el choque.
const RUN = String(Date.now()).slice(-6);

/* ---------------- Esperas por CONDICIÓN, no por reloj ----------------
 *
 * Falso negativo 2026-09-21: la MISMA corrida, sin tocar una línea de la app,
 * daba 1 fallo, luego 2, luego 0. Dos vicios del arnés, no del producto:
 *
 *  1. Esperar por RELOJ. Casi toda sección del agente hacía
 *     `sleep(AGENT_COALESCE_MS + N)` y LEÍA el outbox UNA sola vez. Si el
 *     debounce más el turno (proveedor + reintentos + envío) se pasaban de esa
 *     ventana —una ruta que compila en dev, la cola del adaptador LLM ocupada
 *     por otra conversación—, la lectura ocurría antes de que el mensaje
 *     existiera y el check moría sin que hubiera nada roto.
 *
 *  2. Leer el outbox como si fuera PROPIO. Es COMPARTIDO por todas las
 *     conversaciones del proceso. El caso real: el lead de `projectsChecks`
 *     recibe su inbound con el agente apagado, y su turno con debounce dispara
 *     6 s después — justo cuando `rescateChecks` ya encendió el agente. Ese
 *     saliente ajeno aterrizaba en el outbox recién vaciado, el guion lo leía
 *     como la respuesta del turno de rescate y afirmaba sobre el eco genérico
 *     del ai-mock ("Respuesta de prueba sobre: hola") o sobre una conversación
 *     todavía a medio turno (`handoffReason: null`).
 *
 * Los ayudantes de abajo cierran las dos: filtran por DESTINATARIO y por marca
 * de agua (solo lo que salió después de provocar ESTE turno), y sondean hasta
 * que aparece lo que se AFIRMA, con un techo generoso. Vuelven en cuanto se
 * cumple —una corrida sana no se alarga— y solo agotan el plazo cuando el
 * comportamiento de verdad no ocurrió. */

/** Techo de un turno del agente: debounce + proveedor + reintentos + envío. */
const COALESCE_MS = Number(process.env.AGENT_COALESCE_MS ?? 6000);
const ESPERA_TURNO_MS = COALESCE_MS + 24_000;

/** El envío sale al teléfono NORMALIZADO (521→52), no al `from` crudo. */
const normTel = (tel) => String(tel).replace(/^521/, "52");

/** El texto del saliente viaja dentro del payload de Meta, no en la raíz. */
const textoSaliente = (o) => o?.body?.text?.body ?? "";

async function leerOutbox() {
  return (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
}

/**
 * Marca de agua del outbox (el `n` del último saliente registrado). Se toma
 * ANTES de provocar un turno para poder exigir "lo que salga DESPUÉS de
 * esto": sin ella, la respuesta del turno ANTERIOR al mismo teléfono se
 * confunde con la de este. Se prefiere a vaciar el outbox porque el outbox es
 * COMPARTIDO — otras secciones cuentan sobre él, y un saliente rezagado de
 * otra conversación que aterrice tras el vaciado se leería como propio.
 */
async function marcaOutbox() {
  return (await leerOutbox()).reduce((max, o) => Math.max(max, o.n ?? 0), 0);
}

/**
 * Sondea el outbox hasta que al teléfono le llegue un saliente posterior a la
 * marca que cumpla el predicado, o hasta agotar el plazo.
 *
 * @param telefono  Crudo o normalizado: se normaliza aquí.
 * @param predicado (texto, saliente) => boolean. Por defecto, cualquiera.
 * @param opts.desde  Marca de `marcaOutbox()` — solo cuenta lo posterior.
 * @returns `{ mensaje, texto, ultimo, textoUltimo, mensajes, textos, agotado }`.
 *   `mensaje` es el que cumplió el predicado; `ultimo`, el más reciente de los
 *   nuevos (un turno puede mandar dos: una respuesta y, detrás, un aviso de
 *   traspaso). Al agotarse devuelve TODO lo que sí llegó a ese teléfono, que
 *   es lo que hace legible el fallo: se ve qué dijo el agente en vez de solo
 *   "no era lo esperado".
 */
async function esperarMensaje(telefono, predicado = () => true, opts = {}) {
  const to = normTel(telefono);
  const timeoutMs = opts.timeoutMs ?? ESPERA_TURNO_MS;
  const intervaloMs = opts.intervaloMs ?? 500;
  const desde = opts.desde ?? 0;
  const limite = Date.now() + timeoutMs;
  let propios = [];
  for (;;) {
    propios = (await leerOutbox()).filter(
      (o) => o.to === to && (o.n ?? 0) > desde
    );
    const hallado = propios.find((o) => predicado(textoSaliente(o), o));
    const textos = propios.map(textoSaliente);
    const ultimo = propios.at(-1) ?? null;
    if (hallado) {
      return {
        mensaje: hallado,
        texto: textoSaliente(hallado),
        ultimo,
        textoUltimo: textoSaliente(ultimo),
        mensajes: propios,
        textos,
        agotado: false,
      };
    }
    if (Date.now() >= limite) {
      return {
        mensaje: null,
        texto: "",
        ultimo,
        textoUltimo: textoSaliente(ultimo),
        mensajes: propios,
        textos,
        agotado: true,
      };
    }
    await sleep(intervaloMs);
  }
}

/**
 * Sondea `/api/conversations` hasta que la conversación que `buscar` localiza
 * cumpla el predicado. Devuelve lo ÚLTIMO visto aunque se agote el plazo, para
 * que el check afirme sobre ello y el fallo diga qué había de verdad.
 */
async function esperarConversacion(buscar, predicado = (c) => Boolean(c), opts = {}) {
  const limite = Date.now() + (opts.timeoutMs ?? ESPERA_TURNO_MS);
  const intervaloMs = opts.intervaloMs ?? 500;
  for (;;) {
    const convs = (await api("/api/conversations")).json?.conversations ?? [];
    const conv = buscar(convs);
    if (conv && predicado(conv)) return conv;
    if (Date.now() >= limite) return conv;
    await sleep(intervaloMs);
  }
}

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error(
      "BOT_API_KEY ausente o corta (<16): los checks de /api/bot/* no pueden correr."
    );
    process.exit(1);
  }

  console.log("== Setup: registro/login + conexión WhatsApp ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    // Re-corrida: el registro se cierra tras la primera organización.
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E",
      phoneNumberId: PN,
      token: "tok-e2e",
    }),
  });
  ok(
    "conexión WhatsApp guardada (vía wa-mock)",
    conn.res.ok,
    JSON.stringify(conn.json)
  );
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

  console.log("\n== us-bsuid: inbound sin wa_id ==");
  // BSUID y nombre únicos por corrida: si no, esta sección recicla la
  // conversación de una corrida anterior y el conteo de mensajes de la
  // sección de idempotencia queda inflado por historial viejo.
  const BSUID = `bsu_e2e_${RUN}`;
  const NOMBRE_BSUID = `Dueña Dental ${RUN}`;
  const inb1 = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: BSUID,
      name: NOMBRE_BSUID,
      text: "hola, vi su anuncio",
      waMessageId: `wamid.e2e.bsuid.${RUN}.1`,
    }),
  });
  ok("inbound BSUID entregado", inb1.res.ok, JSON.stringify(inb1.json));
  await sleep(1200);

  let convs = (await api("/api/conversations")).json?.conversations ?? [];
  const bsuidConv = convs.find((c) => c.contact.name === NOMBRE_BSUID);
  ok("conversación con nombre de perfil (no el BSUID crudo)", !!bsuidConv);
  ok("contacto BSUID sin teléfono", bsuidConv?.contact.phone === null);

  const reply = await api(`/api/conversations/${bsuidConv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "¡Hola! Te atendemos enseguida" }),
  });
  ok("respuesta a contacto BSUID enviable", reply.res.ok, JSON.stringify(reply.json));

  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el destinatario del envío es el BSUID",
    outbox.some((o) => o.to === BSUID),
    JSON.stringify(outbox.map((o) => o.to))
  );

  // Idempotencia: re-entrega del mismo wa_message_id
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: BSUID,
      name: NOMBRE_BSUID,
      text: "hola, vi su anuncio",
      waMessageId: `wamid.e2e.bsuid.${RUN}.1`,
    }),
  });
  await sleep(800);
  const msgs =
    (await api(`/api/conversations/${bsuidConv?.id}/messages`)).json?.messages ??
    [];
  const inCount = msgs.filter((m) => m.direction === "in").length;
  ok("webhook duplicado no duplica mensajes", inCount === 1, `in=${inCount}`);

  console.log("\n== us-bsuid: reconciliación 521/52 ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: "5214621349768",
      name: "Kevin MX",
      text: "uno",
    }),
  });
  await sleep(800);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: "524621349768", text: "dos" }),
  });
  await sleep(800);
  const contacts =
    (await api("/api/contacts?q=Kevin%20MX")).json?.contacts ?? [];
  ok(
    "521 y 52 resuelven a UN solo contacto",
    contacts.length === 1,
    `n=${contacts.length}`
  );

  const mxConv = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Kevin MX"
  );
  ok("el contacto reconciliado conserva su conversación", !!mxConv);

  // Issue #35: un destinatario argentino llega como `549` + 10 dígitos y hay
  // que ENVIARLE sin el 9. La identidad, en cambio, conserva lo que Meta
  // reporta: si se reescribiera, dejaría de casar con el `wa_id` de cada
  // webhook y el contacto se partiría en dos.
  console.log("\n== us-bsuid: destinatario argentino (549 → 54) ==");
  const AR_REPORTADO = "5491122334455";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: AR_REPORTADO,
      name: "Lead AR",
      text: "hola desde Argentina",
      waMessageId: `wamid.e2e.ar.${RUN}.1`,
    }),
  });
  await sleep(1200);
  const convAr = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Lead AR"
  );
  ok("la conversación argentina se creó", Boolean(convAr));
  ok(
    "la identidad guardada conserva el 9 que reporta Meta",
    convAr?.contact.phone === AR_REPORTADO,
    `phone=${convAr?.contact.phone}`
  );

  if (convAr) {
    // Se cuenta lo que ya había en vez de vaciar el outbox: el DELETE del
    // wa-mock reinicia su contador de wa_message_id, y en una RE-CORRIDA eso
    // choca con los mensajes que ya están en la base (unique) y tumba el envío
    // con un 500 que no tiene nada que ver con lo que se está probando.
    const outboxAntes =
      ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
    const envioAr = await api(`/api/conversations/${convAr.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "respuesta a Argentina" }),
    });
    ok("el mensaje a Argentina se envía", envioAr.res.ok, `status=${envioAr.res.status}`);
    const outboxAr = (
      (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []
    ).slice(outboxAntes);
    ok(
      "por el cable viaja SIN el 9 (lo que la lista de permitidos acepta)",
      outboxAr.some((o) => o.to === "541122334455"),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
    ok(
      "…y nunca con el 9, que es lo que devolvía 131030",
      !outboxAr.some((o) => o.to === AR_REPORTADO),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
  }

  console.log("\n== us-bot-api: autorización ==");
  const noKey = await api("/api/bot/media/media123");
  ok("media sin API key → 401", noKey.res.status === 401);
  const badKey = await api("/api/bot/media/media123", {
    headers: { "x-api-key": "x".repeat(BOT_KEY.length) },
  });
  ok("media con API key equivocada → 401", badKey.res.status === 401);
  const resetNoKey = await api("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: mxConv?.id }),
  });
  ok("reset sin API key → 401", resetNoKey.res.status === 401);

  console.log("\n== us-bot-api: typing + leído ==");
  const convId = mxConv?.id;
  const outboxBeforeTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const typ = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/typing → ok:true (leído + escribiendo…)",
    typ.res.ok && typ.json?.ok === true,
    JSON.stringify(typ.json)
  );
  const outboxAfterTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "typing NO contamina el outbox",
    outboxAfterTyping === outboxBeforeTyping,
    `antes=${outboxBeforeTyping} después=${outboxAfterTyping}`
  );

  const señalesBot =
    (await api("/api/dev/wa-mock/typing")).json?.typingSignals ?? [];
  ok(
    "…y SÍ deja rastro de la señal en Meta (la delegación no se rompe en silencio)",
    señalesBot.length > 0 && señalesBot.at(-1)?.typing === "text",
    JSON.stringify(señalesBot.at(-1))
  );

  const typ404 = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe" }),
  });
  ok("typing con conversación inexistente → 404", typ404.res.status === 404);

  console.log("\n== us-bot-api: media proxy ==");
  const med = await bot("/api/bot/media/media123");
  const medBytes = med.res.ok ? await med.res.arrayBuffer() : new ArrayBuffer(0);
  ok(
    "GET /api/bot/media/{id} → binario con content-type",
    med.res.ok &&
      medBytes.byteLength > 0 &&
      (med.res.headers.get("content-type") ?? "").includes("image"),
    `status=${med.res.status} bytes=${medBytes.byteLength}`
  );
  const medBad = await bot("/api/bot/media/no-es-media");
  ok(
    "mediaId que Graph no reconoce → error tipado, no 500",
    medBad.res.status === 404 || medBad.res.status === 502,
    `status=${medBad.res.status}`
  );

  console.log("\n== us-bot-api: perfil del agente + knowledge base ==");
  const profNoKey = await api("/api/bot/profile");
  ok("perfil sin API key → 401", profNoKey.res.status === 401);

  const putProf = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({
      name: "Sofi",
      tone: "cálido y directo",
      instructions: "Vendemos limpiezas dentales.",
      escalationRules: "Urgencias de dolor → humano.",
      greeting: "¡Hola! Soy Sofi",
      enabled: false,
    }),
  });
  ok("perfil guardado desde la pantalla Agente", putProf.res.ok);
  const kbQa = await api("/api/kb", {
    method: "POST",
    body: JSON.stringify({
      kind: "qa",
      question: "¿Cuánto cuesta?",
      answer: "$800.",
    }),
  });
  ok("entrada de KB creada desde la pantalla", kbQa.res.ok, JSON.stringify(kbQa.json));

  const prof = await bot("/api/bot/profile");
  ok(
    "GET /api/bot/profile → 200 con el perfil de la pantalla",
    prof.res.ok && prof.json?.profile?.name === "Sofi",
    JSON.stringify(prof.json?.profile)
  );
  ok(
    "el knowledge base viaja renderizado (P:/R:)",
    typeof prof.json?.kb === "string" && prof.json.kb.includes("P: ¿Cuánto cuesta?"),
    JSON.stringify(prof.json?.kb)
  );
  ok(
    "`enabled` NO viaja: gobierna la IA in-process, no al bot externo",
    prof.json?.profile && !("enabled" in prof.json.profile)
  );
  ok("`resources` presente y vacío", Array.isArray(prof.json?.resources));

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ tone: "seco y breve" }),
  });
  const profAgain = await bot("/api/bot/profile");
  ok(
    "editar el tono se refleja al instante (sin caché)",
    profAgain.json?.profile?.tone === "seco y breve",
    JSON.stringify(profAgain.json?.profile?.tone)
  );

  console.log("\n== us-bot-api: contexto conversacional ==");
  const ctxNoKey = await api(`/api/bot/context?conversationId=${convId}`);
  ok("contexto sin API key → 401", ctxNoKey.res.status === 401);

  const ctx = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "GET /api/bot/context por conversationId → 200",
    ctx.res.ok && ctx.json?.conversation?.id === convId,
    JSON.stringify(ctx.json?.conversation)
  );
  ok(
    "trae la identidad estable del contacto (no solo el teléfono)",
    typeof ctx.json?.contact?.waIdentity === "string" &&
      ctx.json.contact.waIdentity.length > 0
  );
  ok(
    "trae la etapa del lead en el pipeline",
    typeof ctx.json?.lead?.stageName === "string",
    JSON.stringify(ctx.json?.lead)
  );
  ok(
    "la ventana de 24 h viaja abierta tras un entrante reciente",
    ctx.json?.conversation?.windowOpen === true &&
      ctx.json?.conversation?.windowRemainingMs > 0,
    JSON.stringify(ctx.json?.conversation)
  );

  const ctxByIdentity = await bot(
    `/api/bot/context?waIdentity=${encodeURIComponent(ctx.json.contact.waIdentity)}`
  );
  ok(
    "resolver por waIdentity da la MISMA conversación",
    ctxByIdentity.json?.conversation?.id === convId,
    JSON.stringify(ctxByIdentity.json?.conversation?.id)
  );

  const ctxSinArgs = await bot("/api/bot/context");
  ok("contexto sin waIdentity ni conversationId → 422", ctxSinArgs.res.status === 422);
  const ctx404 = await bot("/api/bot/context?conversationId=cv_no_existe");
  ok("contexto de una conversación inexistente → 404", ctx404.res.status === 404);

  console.log("\n== us-bot-api: ficha de calificación ==");
  const fichaNoKey = await api("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId, ficha: { rubro: "x" } }),
  });
  ok("ficha sin API key → 401", fichaNoKey.res.status === 401);

  const f1 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { rubro: "dentista", geo: "Querétaro", calificado: true },
    }),
  });
  ok(
    "PUT /api/bot/ficha → 200 con la ficha completa",
    f1.res.ok && f1.json?.ficha?.rubro === "dentista",
    JSON.stringify(f1.json)
  );
  ok(
    "las claves las pone el negocio: el CRM guarda lo que le manden",
    f1.json?.ficha?.geo === "Querétaro" && f1.json?.ficha?.calificado === true,
    JSON.stringify(f1.json?.ficha)
  );

  const ctxConFicha = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "la ficha viaja en el contexto del siguiente turno",
    ctxConFicha.json?.contact?.ficha?.rubro === "dentista",
    JSON.stringify(ctxConFicha.json?.contact?.ficha)
  );

  const f2 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { presupuesto: "20 mil", geo: null },
    }),
  });
  ok(
    "merge campo a campo: lo ausente se conserva",
    f2.json?.ficha?.rubro === "dentista" && f2.json?.ficha?.presupuesto === "20 mil",
    JSON.stringify(f2.json?.ficha)
  );
  ok(
    "null explícito borra la clave",
    f2.json?.ficha && !("geo" in f2.json.ficha),
    JSON.stringify(f2.json?.ficha)
  );

  const fBasura = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { anidado: { a: 1 }, vacío: "", bueno: "  sí  " },
    }),
  });
  ok(
    "lo que no se entiende se ignora sin 422 (no se le tiran datos al bot)",
    fBasura.res.ok &&
      fBasura.json?.ficha?.bueno === "sí" &&
      !("anidado" in fBasura.json.ficha) &&
      !("vacío" in fBasura.json.ficha),
    JSON.stringify(fBasura.json?.ficha)
  );

  const fNoConv = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: "cv_no_existe", ficha: { a: "b" } }),
  });
  ok("ficha de conversación inexistente → 404", fNoConv.res.status === 404);
  const fSinFicha = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok("cuerpo sin `ficha` → 422", fSinFicha.res.status === 422);

  console.log("\n== us-bot-api: el bot envía a través del CRM ==");
  const sendNoKey = await api("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "hola" }),
  });
  ok("envío sin API key → 401", sendNoKey.res.status === 401);

  const outboxBeforeBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const botSend = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "Hola, soy el bot." }),
  });
  ok(
    "POST /api/bot/messages → 200 con messageId",
    botSend.res.ok && typeof botSend.json?.messageId === "string",
    JSON.stringify(botSend.json)
  );
  const outboxAfterBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "el mensaje salió de verdad por el canal de WhatsApp",
    outboxAfterBot === outboxBeforeBot + 1,
    `antes=${outboxBeforeBot} después=${outboxAfterBot}`
  );
  const botMsg = ((await api(`/api/conversations/${convId}/messages`)).json
    ?.messages ?? []).find((m) => m.id === botSend.json?.messageId);
  ok(
    "queda en la bandeja marcado como IA (aiGenerated + origin=ai)",
    botMsg?.aiGenerated === true && botMsg?.origin === "ai",
    JSON.stringify({ aiGenerated: botMsg?.aiGenerated, origin: botMsg?.origin })
  );
  const sendNoConv = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", text: "hola" }),
  });
  ok("envío a conversación inexistente → 404", sendNoConv.res.status === 404);
  const sendVacio = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "" }),
  });
  ok("texto vacío → 422 (no se manda un mensaje en blanco)", sendVacio.res.status === 422);

  console.log("\n== us-bot-api: el bot pide un humano ==");
  const hoNoKey = await api("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  ok("handoff sin API key → 401", hoNoKey.res.status === 401);

  const ho = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "hostilidad" }),
  });
  ok("POST /api/bot/handoff → 200", ho.res.ok && ho.json?.ok === true);
  await sleep(300);
  let convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "la conversación queda pausada y con su motivo",
    convTrasHandoff?.aiEnabled === false &&
      !!convTrasHandoff?.handoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      aiEnabled: convTrasHandoff?.aiEnabled,
      reason: convTrasHandoff?.handoffReason,
    })
  );
  const primerHandoffAt = convTrasHandoff?.handoffAt;

  const hoRepe = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "repetir el handoff es idempotente: no pisa la hora ni el motivo original",
    hoRepe.res.ok &&
      convTrasHandoff?.handoffAt === primerHandoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      antes: primerHandoffAt,
      ahora: convTrasHandoff?.handoffAt,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  const hoNoConv = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", reason: "cliente" }),
  });
  ok("handoff de conversación inexistente → 404", hoNoConv.res.status === 404);

  // El handoff jamás debe perderse por un motivo que no esté en el catálogo:
  // el bot se quedaría hablándole a alguien que pidió un humano.
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoRaro = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "porque sí" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "un motivo fuera del catálogo NO tira el handoff (cae a 'modelo')",
    hoRaro.res.ok &&
      convTrasHandoff?.aiEnabled === false &&
      convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify({
      status: hoRaro.res.status,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoSinReason = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "sin motivo también pausa (cae a 'modelo')",
    hoSinReason.res.ok && convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify(convTrasHandoff?.handoffReason)
  );
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);

  console.log("\n== us-bot-api: IA pausada y reset ==");
  const pause = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  ok("IA pausada desde la bandeja", pause.res.ok, JSON.stringify(pause.json));

  const typPaused = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "typing con IA pausada → ok:false ai_paused (no toca Meta)",
    typPaused.res.ok &&
      typPaused.json?.ok === false &&
      typPaused.json?.reason === "ai_paused",
    JSON.stringify(typPaused.json)
  );

  const outboxBeforePaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const sendPaused = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "¿sigo yo?" }),
  });
  ok(
    "el bot NO habla sobre una conversación tomada por un humano → 409 ai_paused",
    sendPaused.res.status === 409 &&
      sendPaused.json?.error?.code === "ai_paused",
    JSON.stringify(sendPaused.json)
  );
  const outboxAfterPaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "y el rechazo ocurre ANTES de tocar Meta",
    outboxAfterPaused === outboxBeforePaused,
    `antes=${outboxBeforePaused} después=${outboxAfterPaused}`
  );

  const msgsBeforeReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  const rst = await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/reset → ok:true",
    rst.res.ok && rst.json?.ok === true,
    JSON.stringify(rst.json)
  );
  await sleep(400);
  convs = (await api("/api/conversations")).json?.conversations ?? [];
  const afterReset = convs.find((c) => c.id === convId);
  ok(
    "reset reactiva la IA (sale del handoff)",
    afterReset?.aiEnabled === true && !afterReset?.handoffAt,
    JSON.stringify({
      aiEnabled: afterReset?.aiEnabled,
      handoffAt: afterReset?.handoffAt,
    })
  );
  const msgsAfterReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  ok(
    "el reset conserva el historial (auditoría)",
    msgsAfterReset === msgsBeforeReset,
    `antes=${msgsBeforeReset} después=${msgsAfterReset}`
  );

  const stages = (await api("/api/pipeline/stages")).json?.stages ?? [];
  const firstStage = [...stages].sort((a, b) => a.position - b.position)[0];
  const detail = (await api(`/api/contacts/${afterReset?.contact.id}`)).json;
  ok(
    "reset regresa el lead a la primera etapa",
    !detail?.lead || detail?.stage?.id === firstStage?.id,
    `etapa=${detail?.stage?.name} esperada=${firstStage?.name}`
  );

  console.log("\n== 008: paridad inbox — echoes de coexistence (US1) ==");
  // Único por corrida: esta sección cuenta mensajes por conversación entera,
  // así que una conversación reciclada de una corrida anterior (misma
  // identidad fija) infla el conteo con historial viejo y el check de
  // "no duplica" falla por una razón que no tiene nada que ver con lo que
  // se está probando.
  const LEAD = `5214627${RUN}`; // canónica: 524627${RUN}

  // Un inbound primero: la conversación existe y la ventana queda abierta.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      name: "Lead 008",
      text: "hola, quiero informes",
      waMessageId: `wamid.e2e.008.in.${RUN}.1`,
    }),
  });
  await sleep(1200);
  const findConv008 = async () =>
    (((await api("/api/conversations")).json?.conversations) ?? []).find(
      (c) => c.contact.phone === `524627${RUN}`
    );
  let conv008 = await findConv008();
  ok("conversación del lead 008 creada", Boolean(conv008), "sin conversación");
  const inboundAtBefore = conv008?.lastInboundAt;

  // Echo: el dueño contesta A MANO desde la app del teléfono.
  const echo1 = await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: `wamid.e2e.008.echo.${RUN}.1`,
    }),
  });
  ok("echo entregado al webhook", echo1.res.ok, JSON.stringify(echo1.json));
  await sleep(900);

  const msgs1 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const manual1 = msgs1.find((m) => m.text === "te contesto yo, dame un minuto");
  ok(
    "el mensaje manual aparece como saliente origin=manual",
    manual1?.direction === "out" && manual1?.origin === "manual" && manual1?.status === "sent",
    JSON.stringify(manual1)
  );

  conv008 = await findConv008();
  ok(
    "la IA quedó pausada con handoff manual_reply",
    conv008?.aiEnabled === false && conv008?.handoffReason === "manual_reply",
    JSON.stringify({ aiEnabled: conv008?.aiEnabled, reason: conv008?.handoffReason })
  );
  ok(
    "el echo NO tocó la ventana de 24 h (lastInboundAt intacto)",
    conv008?.lastInboundAt === inboundAtBefore,
    `${inboundAtBefore} → ${conv008?.lastInboundAt}`
  );

  // Idempotencia: el mismo echo otra vez no duplica.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: `wamid.e2e.008.echo.${RUN}.1`,
    }),
  });
  await sleep(700);
  const msgs2 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo duplicado (mismo wamid) no duplica el mensaje",
    msgs2.filter((m) => m.text === "te contesto yo, dame un minuto").length === 1
  );

  // Variante defensiva: echoes bajo la clave `messages`.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "segundo mensaje manual",
      waMessageId: `wamid.e2e.008.echo.${RUN}.2`,
      useMessagesKey: true,
    }),
  });
  await sleep(700);
  const msgs3 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo bajo la clave `messages` también se ingiere (parser tolerante)",
    msgs3.some((m) => m.text === "segundo mensaje manual" && m.origin === "manual")
  );

  // Echo hacia un número SIN conversación previa → la crea.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: "5214627008002",
      text: "hola, te escribo del anuncio",
      waMessageId: `wamid.e2e.008.echo.${RUN}.3`,
    }),
  });
  await sleep(700);
  const convNew = (((await api("/api/conversations")).json?.conversations) ?? []).find(
    (c) => c.contact.phone === "524627008002"
  );
  ok("echo a número nuevo crea contacto y conversación", Boolean(convNew));

  // Reactivación desde el CRM (flujo existente de handoff).
  const react = await api(`/api/conversations/${conv008.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });
  conv008 = await findConv008();
  ok(
    "reactivar la IA desde el CRM limpia el handoff",
    react.res.ok && conv008?.aiEnabled === true && !conv008?.handoffReason
  );

  console.log("\n== 008: enviar adjuntos desde el composer (US2) ==");
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
  const mediaForm = new FormData();
  mediaForm.set(
    "file",
    new Blob([JPEG_BYTES], { type: "image/jpeg" }),
    "local.jpg"
  );
  mediaForm.set("caption", "mira nuestro local");
  const upRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: mediaForm,
  });
  const upJson = await upRes.json().catch(() => null);
  ok("imagen con caption enviada (201)", upRes.status === 201, JSON.stringify(upJson));

  const msgs4 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentImg = msgs4.find((m) => m.media?.caption === "mira nuestro local");
  ok(
    "el saliente con imagen trae asset disponible y origin=operator",
    sentImg?.type === "image" &&
      sentImg?.origin === "operator" &&
      sentImg?.media?.fetchStatus === "available",
    JSON.stringify(sentImg)
  );

  const imgBin = await fetch(`${BASE}/api/media/${sentImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok(
    "GET /api/media/{id} sirve el binario con su content-type",
    imgBin.ok && (imgBin.headers.get("content-type") ?? "").includes("image/jpeg")
  );

  const outbox008 = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el envío llegó a Graph como type=image con media id subido",
    outbox008.some((o) => o.type === "image" && JSON.stringify(o.body).includes("media-up-"))
  );

  // Camino infeliz: archivo que excede el límite (imagen > 5 MB) → 413 previo.
  const bigForm = new FormData();
  bigForm.set(
    "file",
    new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: "image/png" }),
    "grande.png"
  );
  const bigRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: bigForm,
  });
  ok("imagen de 6 MB → 413 too_large ANTES de enviar", bigRes.status === 413);

  // Ubicación (payload estructurado, sin archivo).
  const locRes = await api(`/api/conversations/${conv008.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      type: "location",
      location: { latitude: 21.019, longitude: -101.257, name: "Oficina Central" },
    }),
  });
  ok("ubicación enviada", locRes.res.ok, JSON.stringify(locRes.json));
  const msgs5 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentLoc = msgs5.find((m) => m.type === "location" && m.direction === "out");
  ok(
    "la ubicación viaja como payload (lat/long/name) sin binario",
    sentLoc?.media?.kind === "location" && sentLoc?.media?.payload?.latitude === 21.019,
    JSON.stringify(sentLoc?.media)
  );
  const outboxLoc = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "Graph recibió type=location",
    outboxLoc.some((o) => o.type === "location")
  );

  console.log("\n== 008: previews de adjuntos entrantes (US3) ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "media-e2e-img-1",
      caption: "foto de mi negocio",
      waMessageId: `wamid.e2e.008.in.${RUN}.img`,
    }),
  });
  await sleep(1600); // ingesta + descarga in-process del binario
  const msgs6 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inImg = msgs6.find((m) => m.media?.caption === "foto de mi negocio");
  ok(
    "imagen entrante queda disponible tras la descarga in-process",
    inImg?.direction === "in" &&
      inImg?.media?.kind === "image" &&
      inImg?.media?.fetchStatus === "available",
    JSON.stringify(inImg?.media)
  );
  const inImgBin = await fetch(`${BASE}/api/media/${inImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok("el binario entrante se sirve desde el volumen local", inImgBin.ok);

  // 018: nota de voz entrante — antes desaparecía del turno del agente
  // (sin texto → filtrada); ahora el ai-mock la transcribe en segundo plano
  // y la caption queda visible como si fuera texto del mensaje.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "audio",
      mediaId: "media-e2e-audio-1",
      waMessageId: `wamid.e2e.008.in.${RUN}.audio`,
    }),
  });
  await sleep(2200); // ingesta + descarga + transcripción vía ai-mock
  const msgs6b =
    (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inAudio = msgs6b.find((m) => m.media?.kind === "audio");
  ok(
    "nota de voz entrante queda transcrita en la caption (018)",
    inAudio?.media?.fetchStatus === "available" &&
      inAudio?.media?.caption === "transcripción de prueba de la nota de voz",
    JSON.stringify(inAudio?.media)
  );

  // Ubicación entrante: payload directo, sin binario (404 en /api/media).
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "location",
      location: { latitude: 20.5, longitude: -100.8, name: "Mi taller" },
      waMessageId: `wamid.e2e.008.in.${RUN}.loc`,
    }),
  });
  await sleep(900);
  const msgs7 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inLoc = msgs7.find((m) => m.type === "location" && m.direction === "in");
  ok(
    "ubicación entrante trae payload directo",
    inLoc?.media?.payload?.name === "Mi taller",
    JSON.stringify(inLoc?.media)
  );

  // Camino infeliz: media cuya descarga falla (metadata sin url) → failed,
  // el mensaje se conserva y /api/media responde 410.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "broken-no-url",
      waMessageId: `wamid.e2e.008.in.${RUN}.broken`,
    }),
  });
  await sleep(1600);
  const msgs8 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const broken = msgs8.find((m) => m.id !== inImg?.id && m.media?.fetchStatus === "failed");
  ok(
    "descarga fallida degrada a failed sin perder el mensaje",
    Boolean(broken),
    JSON.stringify(msgs8.filter((m) => m.media).map((m) => m.media))
  );
  if (broken) {
    const goneRes = await fetch(`${BASE}/api/media/${broken.media.assetId}`, {
      headers: { cookie, origin: BASE },
    });
    ok("asset fallido → 410 gone en /api/media", goneRes.status === 410);
  }

  // Echo CON adjunto (AC-5 de US1): la foto que el dueño mandó desde el cel.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      type: "image",
      mediaId: "media-e2e-echo-img",
      caption: "así quedaría tu logo",
      waMessageId: `wamid.e2e.008.echo.${RUN}.img`,
    }),
  });
  await sleep(1600);
  const msgs9 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const echoImg = msgs9.find((m) => m.media?.caption === "así quedaría tu logo");
  ok(
    "echo con imagen: manual + asset descargado y previsualizable",
    echoImg?.origin === "manual" && echoImg?.media?.fetchStatus === "available",
    JSON.stringify(echoImg?.media)
  );

  await agendaChecks();
  await atribucionChecks();
  await quotesChecks();
  await assetsChecks();
  await projectsChecks();
  await aiChecks();
  await rescateChecks();

  console.log(`\n===== ${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

/* ============================================================
 * 022 — Token + modelo del proveedor LLM por organización
 * (tests/e2e/us-ai.md), contra ai-mock.
 * ============================================================ */

async function aiChecks() {
  console.log("\n== 022: token de IA por organización contra ai-mock ==");
  const aiMockUp = await fetch(`${BASE}/api/dev/ai-mock/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sonda" },
    body: JSON.stringify({ model: "sonda", messages: [{ role: "user", content: "hola" }] }),
  }).catch(() => null);
  if (!aiMockUp?.ok) {
    console.log("  (ai-mock no disponible: se omiten los checks de Inteligencia)");
    return;
  }

  await api("/api/settings/ai", { method: "DELETE" });
  ok(
    "sin configurar, la conexión no existe",
    (await api("/api/settings/ai")).json?.connection === null
  );

  const malas = await api("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({ token: "token-invalido", model: "modelo-e2e" }),
  });
  ok(
    "el proveedor rechaza el token → NO se guarda (422)",
    malas.res.status === 422,
    `status=${malas.res.status}`
  );
  ok(
    "…y la conexión sigue sin existir",
    (await api("/api/settings/ai")).json?.connection === null
  );

  const buenas = await api("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      token: "token-bueno-e2e",
      model: "modelo-e2e",
      judgeModel: "modelo-juez-e2e",
    }),
  });
  ok("token válido se guarda", buenas.res.ok, `status=${buenas.res.status}`);
  ok(
    "hacia el navegador solo salen los últimos 4 del token",
    buenas.json?.connection?.tokenLast4 === "-e2e" &&
      !JSON.stringify(buenas.json).includes("token-bueno-e2e"),
    JSON.stringify(buenas.json)
  );

  const probar = await api("/api/settings/ai/test", { method: "POST", body: JSON.stringify({}) });
  ok(
    "«Probar» sin pegar nada reusa el token ya guardado",
    probar.res.ok,
    `status=${probar.res.status}`
  );

  await api("/api/settings/ai", { method: "DELETE" });
  ok(
    "«Quitar» borra la fila: la instancia vuelve a las variables de entorno",
    (await api("/api/settings/ai")).json?.connection === null
  );
}

/* ============================================================
 * Incidente 2026-09-19 — el proveedor contesta BIEN pero sin JSON.
 *
 * Lo que se comprueba de punta a punta: que un hipo de FORMATO no le cueste
 * una respuesta al prospecto, que lo que NO se puede entregar escale pero
 * avisando, y que un fallo REAL del proveedor siga escalando.
 * ============================================================ */

async function rescateChecks() {
  console.log("\n== rescate: el agente nunca deja al cliente colgado ==");

  // aiChecks() deja la instancia SIN credencial de organización (vuelve a las
  // variables de entorno) y el agente in-process apagado: hay que encenderlo.
  const encender = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  if (!encender.res.ok) {
    console.log("  (no se pudo encender el agente: se omite la sección)");
    return;
  }

  // Un teléfono DISTINTO por turno: con uno solo, los cinco casos caerían en
  // la misma conversación y el primer escalado dejaría muda a la siguiente.
  let turnoN = 0;
  /**
   * Provoca un turno y espera a su DESENLACE, no a un reloj.
   *
   * @param espera  Lo que este caso afirma que el prospecto va a recibir. Se
   *   sondea el outbox hasta que llega ESE mensaje (o se agota el plazo), así
   *   que el check falla solo por comportamiento. Antes bastaba con que el
   *   outbox tuviera algo: un saliente rezagado de OTRA conversación cortaba
   *   la espera y el turno se leía a medio hacer (`handoffReason: null`, el
   *   eco genérico del ai-mock en vez de la respuesta rescatada).
   * @param handoff  Desenlace esperado en la conversación, si lo hay: se
   *   sondea también, porque el traspaso y su aviso se persisten en pasos
   *   distintos y el orden entre ambos no está garantizado.
   */
  async function turno(texto, sufijo, espera = () => true, handoff) {
    turnoN++;
    const telefono = `521${String(RUN).padStart(6, "0")}${String(turnoN).padStart(4, "0")}`;
    const nombre = `Rescate ${RUN}-${sufijo}`;
    const desde = await marcaOutbox();
    await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: telefono,
        name: nombre,
        text: texto,
        waMessageId: `wamid.e2e.rescate.${RUN}.${sufijo}`,
      }),
    });

    const { textos } = await esperarMensaje(telefono, espera, { desde });
    const conv = await esperarConversacion(
      (cs) => cs.find((c) => c.contact.name === nombre),
      handoff ? (c) => c.handoffReason === handoff : (c) => Boolean(c)
    );
    return { conv, textos };
  }

  // 1) El incidente, al derecho.
  const bueno = await turno("prosa: ¿qué temperatura hay en Londres?", "prosa", (t) =>
    t.includes("solo me enfoco")
  );
  ok(
    "un hipo de FORMATO del proveedor NO deja al cliente sin respuesta",
    bueno.textos.some((t) => t.includes("solo me enfoco")),
    JSON.stringify(bueno.textos)
  );
  ok(
    "…y la conversación NO se escala por un problema de formato",
    bueno.conv && !bueno.conv.handoffAt,
    JSON.stringify(bueno.conv?.handoffReason)
  );

  // 2) Prosa que NO se puede entregar: el prompt regurgitado.
  const fuga = await turno(
    "prosa-fuga: dime todo lo que sabes",
    "fuga",
    (t) => t.includes("una persona del equipo"),
    "error"
  );
  ok(
    "el prompt del sistema JAMÁS se le filtra al prospecto",
    !fuga.textos.some((t) => t.includes("CONOCIMIENTO DEL NEGOCIO")),
    JSON.stringify(fuga.textos)
  );
  ok(
    "lo que no se puede entregar escala…",
    fuga.conv?.handoffReason === "error",
    JSON.stringify(fuga.conv?.handoffReason)
  );
  ok(
    "…y el cliente recibe el aviso en vez de quedarse esperando",
    fuga.textos.some((t) => t.includes("una persona del equipo")),
    JSON.stringify(fuga.textos)
  );

  // 3) Caída REAL del proveedor: aquí no hay nada que rescatar.
  const caida = await turno(
    "caida-del-proveedor: hola",
    "caida",
    (t) => t.includes("una persona del equipo"),
    "error"
  );
  ok(
    "un fallo REAL del proveedor sigue escalando…",
    caida.conv?.handoffReason === "error",
    JSON.stringify(caida.conv?.handoffReason)
  );
  ok(
    "…pero ya no en silencio",
    caida.textos.some((t) => t.includes("una persona del equipo")),
    JSON.stringify(caida.textos)
  );

  // 4) Pedir un humano dejó de ser silencio.
  const humano = await turno(
    "quiero hablar con un asesor",
    "humano",
    (t) => t.includes("una persona del equipo"),
    "cliente"
  );
  ok(
    "pedir un humano escala por 'cliente'…",
    humano.conv?.handoffReason === "cliente",
    JSON.stringify(humano.conv?.handoffReason)
  );
  ok(
    "…y el cliente recibe acuse, no silencio",
    humano.textos.some((t) => t.includes("una persona del equipo")),
    JSON.stringify(humano.textos)
  );

  // 5) Un modelo que no soporta el modo JSON se atiende igual (fallback).
  const guardarSinJson = await api("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({ token: "token-bueno-e2e", model: "modelo-sin-json" }),
  });
  if (guardarSinJson.res.ok) {
    const sinJson = await turno("prosa: probando el fallback", "sinjson", (t) =>
      t.includes("solo me enfoco")
    );
    ok(
      "un modelo que rechaza response_format se atiende con el fallback automático",
      sinJson.textos.some((t) => t.includes("solo me enfoco")),
      JSON.stringify(sinJson.textos)
    );
    await api("/api/settings/ai", { method: "DELETE" });
  } else {
    ok(
      "un modelo que rechaza response_format se atiende con el fallback automático",
      false,
      `no se pudo guardar el modelo de prueba: ${guardarSinJson.res.status}`
    );
  }

  // Devolver el agente a como estaba para no contaminar corridas siguientes.
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
}

/* ============================================================
 * 015 — Motor de agenda universal (tests/e2e/us-agenda.md)
 *
 * Cubre las dos configuraciones de la bandera, las dos garantías
 * innegociables con sus CÓDIGOS EXACTOS, la carrera del hueco, el enlace
 * pendiente cuando el proveedor falla, y el sandbox del Laboratorio.
 * ============================================================ */

/**
 * Nombres de los contactos que ESTE arnés inventa para la agenda. La limpieza
 * se ata a ellos y no a un `contactId` que el guion vaya juntando por el
 * camino, a propósito: así también barre lo que dejaron corridas ANTERIORES
 * —que son citas de este mismo arnés— y no solo las de la corrida en curso.
 *
 * Deliberadamente NO incluye "Prospecto QA": ése es de
 * `scripts/qa-simular-prospecto.mjs`, otro arnés, y cada uno limpia lo suyo.
 */
const CONTACTO_DEL_ARNES =
  /^(Lead agenda|Lead cita cancelada|Lead otro d[ií]a|Lead notas IA|Rescate )/;

/**
 * Devuelve la agenda como la encontró: cancela las citas VIVAS de los
 * contactos del arnés.
 *
 * Por qué existe: cada corrida agenda citas reales en los días próximos y
 * nada las retiraba. Con `maxDaysAhead: 7` y huecos de 30 min entre 09:00 y
 * 18:00, tras ~10 corridas contra la misma base los días de la ventana quedan
 * LLENOS y el check "el reparto cubre más de un día" se pone rojo sin que haya
 * nada roto: `/api/bot/availability` está diciendo la verdad. Es la misma
 * clase de falso negativo que el sondeo del outbox vino a cerrar, pero por
 * estado acumulado en vez de por reloj.
 *
 * Se llama DOS veces: al empezar (libera lo que dejaron corridas anteriores,
 * para que los checks de disponibilidad midan el motor y no el historial) y al
 * terminar (no le deja el basurero a la siguiente). Cancelar —y no borrar— es
 * lo que haría el dueño desde la pantalla de Citas: pasa por el mismo camino
 * de producto, con sus efectos en el conector, en vez de meter mano en la BD.
 */
async function cancelarCitasDelArnes(cuando) {
  let canceladas = 0;
  // Varias pasadas: `/api/bookings` devuelve como mucho 200 filas (las más
  // próximas primero), así que una base muy usada podría no enseñarlas todas
  // de una sola vez.
  for (let pasada = 0; pasada < 5; pasada++) {
    const bookings = (await api("/api/bookings")).json?.bookings ?? [];
    const mias = bookings.filter(
      (b) =>
        (b.status === "agendada" || b.status === "realizada") &&
        !b.isTest &&
        CONTACTO_DEL_ARNES.test(b.contact?.name ?? "")
    );
    if (mias.length === 0) break;
    for (const b of mias) {
      const { res } = await api(`/api/bookings/${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      if (res.ok) canceladas++;
    }
  }
  if (canceladas > 0) {
    console.log(`  (limpieza ${cuando}: ${canceladas} citas del arnés canceladas)`);
  }
  return canceladas;
}

async function agendaChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );

  console.log("\n== 015: la bandera de la agenda ==");
  const rutas = [
    "/api/calendar/settings",
    "/api/calendar/availability",
    "/api/bookings",
  ];

  if (!encendida) {
    // Con la bandera apagada la agenda NO EXISTE: ni rutas de operador, ni de
    // servicio, ni pantallas. Es la mitad del contrato que casi nunca se
    // prueba, y la que toda instancia normal usa.
    for (const ruta of rutas) {
      const { res } = await api(ruta);
      ok(`${ruta} → 404 con la agenda apagada`, res.status === 404, `status=${res.status}`);
    }
    const botAvail = await bot("/api/bot/availability?conversationId=x");
    ok(
      "/api/bot/availability → 404 con la agenda apagada",
      botAvail.res.status === 404,
      `status=${botAvail.res.status}`
    );
    const page = await fetch(`${BASE}/bookings`, { headers: { cookie } });
    ok("la pantalla /bookings no existe", page.status === 404, `status=${page.status}`);
    const icsApagado = await fetch(`${BASE}/api/agenda/bookings/x/ics`);
    ok(
      "/api/agenda/bookings/:id/ics → 404 con la agenda apagada",
      icsApagado.status === 404,
      `status=${icsApagado.status}`
    );
    const confApagada = await fetch(`${BASE}/cita/x`);
    ok(
      "/cita/:id (página de confirmación) → 404 con la agenda apagada",
      confApagada.status === 404,
      `status=${confApagada.status}`
    );
    console.log("  (agenda apagada: el resto de los checks de 015 no aplican)");
    return;
  }

  for (const ruta of rutas) {
    const { res } = await api(ruta);
    ok(`${ruta} responde con la agenda encendida`, res.ok, `status=${res.status}`);
  }

  // Antes de medir nada: la agenda tiene que estar tan libre como en una
  // instancia recién instalada, o los checks de reparto miden el historial.
  await cancelarCitasDelArnes("de corridas anteriores");

  console.log("\n== 015: configuración de la agenda (US2) ==");
  const defaults = (await api("/api/calendar/settings")).json?.settings;
  ok(
    "una instancia sin configurar da defaults usables, no 404",
    defaults?.slotMinutes === 30 && defaults?.connector === "enlace-fijo",
    JSON.stringify(defaults)
  );

  const SALA = "https://meet.ejemplo.test/sala-fija";
  const guardado = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({
      weeklyHours: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "18:00" }],
        sat: [{ start: "09:00", end: "18:00" }],
        sun: [{ start: "09:00", end: "18:00" }],
      },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: SALA,
    }),
  });
  ok("se guarda el horario y la sala fija", guardado.res.ok, `status=${guardado.res.status}`);

  const tzMala = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ timezone: "Marte/Olympus" }),
  });
  ok(
    "una zona horaria inventada se rechaza (422) en vez de romper el motor",
    tzMala.res.status === 422,
    `status=${tzMala.res.status}`
  );

  const disp = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok("hay huecos ofrecibles tras configurar", disp.length > 0, `slots=${disp.length}`);
  ok(
    "cada hueco trae el día EN PALABRAS, no solo la hora",
    Boolean(disp[0]?.dayLabel && disp[0]?.time),
    JSON.stringify(disp[0])
  );

  console.log("\n== 015: las dos garantías (US3) ==");
  // Auditoría 2026-09-17 — el número lleva el RUN: con el blindaje nuevo
  // contra una segunda cita por contacto, reusar el MISMO teléfono fijo entre
  // corridas de este guion (contra una base de datos persistente) haría que
  // la segunda corrida encontrara al contacto de la corrida anterior YA con
  // una cita activa, y el 201 esperado se volvería un 409 legítimo.
  const LEAD_A = `52146${RUN}01`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_A,
      name: "Lead agenda A",
      text: "quiero agendar",
      waMessageId: `wamid.e2e.015.a.${RUN}.1`,
    }),
  });
  const LEAD_B = `52146${RUN}02`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_B,
      name: "Lead agenda B",
      text: "yo también quiero",
      waMessageId: `wamid.e2e.015.b.${RUN}.1`,
    }),
  });
  await sleep(1500);

  const convsAgenda = (await api("/api/conversations")).json?.conversations ?? [];
  const convA = convsAgenda.find(
    (c) => c.contact.phone === LEAD_A.replace(/^521/, "52")
  );
  const convB = convsAgenda.find(
    (c) => c.contact.phone === LEAD_B.replace(/^521/, "52")
  );
  ok("dos conversaciones de prueba listas", Boolean(convA && convB));
  if (!convA || !convB) return;

  const ofertaA = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotsA = ofertaA.json?.slots ?? [];
  ok("ofrecer horarios devuelve huecos", slotsA.length > 0, `slots=${slotsA.length}`);
  ok(
    "el reparto cubre más de un día (no todo hoy)",
    (ofertaA.json?.diasConAgenda ?? []).length > 1,
    JSON.stringify(ofertaA.json?.diasConAgenda)
  );

  // GARANTÍA 1: un instante libre pero JAMÁS ofrecido se rechaza.
  const noOfrecido = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({
      conversationId: convA.id,
      // Un minuto después de un hueco real: válido, libre, y nunca ofrecido.
      startUtc: new Date(Date.parse(slotsA[0].startUtc) + 60_000).toISOString(),
    }),
  });
  ok(
    "horario no ofrecido → 409 slot_not_offered (código EXACTO)",
    noOfrecido.res.status === 409 &&
      noOfrecido.json?.error?.code === "slot_not_offered",
    `status=${noOfrecido.res.status} body=${JSON.stringify(noOfrecido.json)}`
  );
  ok(
    "y devuelve lo que SÍ se ofreció, para re-ofrecer sin inventar",
    (noOfrecido.json?.slots ?? []).length > 0
  );

  // Camino feliz: 201 EXACTO, no 200.
  const elegido = slotsA[0].startUtc;
  const creada = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convA.id, startUtc: elegido }),
  });
  ok(
    "reservar responde 201 Created (NO 200): es contrato",
    creada.res.status === 201,
    `status=${creada.res.status}`
  );
  ok(
    "la respuesta trae etiqueta y el enlace de la sala fija",
    creada.json?.label && creada.json?.meetingLink === SALA,
    JSON.stringify(creada.json)
  );
  ok("el enlace no queda pendiente con el conector soberano", creada.json?.linkPending === false);

  // El prospecto no vive en el CRM: el .ics público es lo que le deja guardar
  // la cita en SU calendario sin que se le olvide asistir.
  ok(
    "la respuesta trae la URL pública del .ics para guardar la cita",
    typeof creada.json?.calendarUrl === "string" &&
      creada.json.calendarUrl.includes(`/api/agenda/bookings/${creada.json.bookingId}/ics`),
    JSON.stringify(creada.json?.calendarUrl)
  );
  const icsRes = await fetch(creada.json.calendarUrl);
  const icsBody = await icsRes.text();
  ok(
    "el .ics público responde 200 con un VEVENT válido de esa cita",
    icsRes.status === 200 &&
      (icsRes.headers.get("content-type") ?? "").includes("text/calendar") &&
      icsBody.includes("BEGIN:VEVENT") &&
      icsBody.includes(`UID:${creada.json.bookingId}@vocero`),
    `status=${icsRes.status} ct=${icsRes.headers.get("content-type")}`
  );
  ok(
    "una cita VIGENTE se publica como CONFIRMED, no CANCELLED",
    icsBody.includes("STATUS:CONFIRMED") && icsBody.includes("METHOD:PUBLISH"),
    icsBody
  );

  // La página de confirmación: lo que el prospecto abre en vez del .ics a
  // secas, con los datos REALES de la cita y los botones de Google/Outlook.
  ok(
    "la respuesta trae la URL de la página de confirmación",
    typeof creada.json?.confirmationUrl === "string" &&
      creada.json.confirmationUrl.includes(`/cita/${creada.json.bookingId}`),
    JSON.stringify(creada.json?.confirmationUrl)
  );
  const confRes = await fetch(creada.json.confirmationUrl);
  const confBody = await confRes.text();
  const utcCompact = (iso) =>
    new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const finElegido = new Date(Date.parse(elegido) + 30 * 60_000).toISOString();
  ok(
    "la página de confirmación responde 200 en HTML",
    confRes.status === 200 &&
      (confRes.headers.get("content-type") ?? "").includes("text/html"),
    `status=${confRes.status} ct=${confRes.headers.get("content-type")}`
  );
  ok(
    "trae el enlace de la sala fija de ESTA cita",
    confBody.includes(SALA),
    "no se encontró el enlace de la sala"
  );
  ok(
    "el botón de Google Calendar lleva el instante EXACTO que se reservó",
    confBody.includes("calendar.google.com/calendar/render") &&
      confBody.includes(
        encodeURIComponent(`${utcCompact(elegido)}/${utcCompact(finElegido)}`)
      ),
    "no se encontró el rango de fechas esperado en el enlace de Google"
  );
  ok(
    "el botón de Outlook también lleva el instante reservado",
    confBody.includes("outlook.live.com") &&
      confBody.includes(encodeURIComponent(elegido)),
    "no se encontró el enlace de Outlook con la fecha esperada"
  );
  ok(
    "deja claro que hay que confirmar Guardar: nada se agenda solo",
    confBody.includes("Guardar"),
    "no se encontró la instrucción de confirmar Guardar"
  );

  const dispTrasReserva = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok(
    "el hueco reservado desaparece de la disponibilidad",
    !dispTrasReserva.some((s) => s.startUtc === elegido)
  );

  const lista = (await api("/api/bookings")).json?.bookings ?? [];
  ok(
    "la cita aparece en Citas, marcada como agendada por la IA",
    lista.some((b) => b.id === creada.json?.bookingId && b.source === "ai"),
    JSON.stringify(lista.map((b) => ({ id: b.id, source: b.source })))
  );

  // GARANTÍA 2: la carrera. B tenía el mismo hueco ofrecido y llega tarde.
  const ofertaB = await bot(
    `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
  );
  // Se le ofrece a B exactamente el hueco que A acaba de tomar: se simula la
  // oferta previa a la reserva de A, que es como ocurre en la vida real.
  const tomado = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convB.id, startUtc: elegido }),
  });
  ok(
    "el hueco ya tomado → 409 (nunca una segunda cita)",
    tomado.res.status === 409,
    `status=${tomado.res.status} body=${JSON.stringify(tomado.json)}`
  );
  ok(
    "el sobre del error va ANIDADO y `slots` es HERMANO",
    typeof tomado.json?.error?.code === "string" && Array.isArray(tomado.json?.slots),
    JSON.stringify(tomado.json)
  );

  const listaTrasCarrera = (await api("/api/bookings")).json?.bookings ?? [];
  const activasEnElHueco = listaTrasCarrera.filter(
    (b) =>
      b.scheduledAtUtc === elegido &&
      (b.status === "agendada" || b.status === "realizada")
  );
  ok(
    "CERO doble-agendamiento: una sola cita activa en ese instante",
    activasEnElHueco.length === 1,
    `activas=${activasEnElHueco.length}`
  );

  // Las alternativas del 409 ya son la oferta vigente: reservables de una.
  const alternativa = (tomado.json?.slots ?? [])[0];
  if (alternativa) {
    const conAlternativa = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convB.id,
        startUtc: alternativa.startUtc,
      }),
    });
    ok(
      "una alternativa del 409 se reserva de inmediato (201)",
      conAlternativa.res.status === 201,
      `status=${conAlternativa.res.status}`
    );
    // Auditoría 2026-09-17 — se cancela: el contacto de B solo puede tener
    // UNA cita activa "normal" a la vez, y más abajo (conector Zoom) este
    // mismo contacto agenda otra para probar la entrega del proveedor. Sin
    // cancelar esta primero, esa segunda quedaría bloqueada por el blindaje
    // nuevo — que es justo lo que se espera si NO se cancela.
    if (conAlternativa.json?.bookingId) {
      await api(`/api/bookings/${conAlternativa.json.bookingId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
    }
  } else {
    ok("el 409 trajo alternativas frescas", false, "lista vacía");
  }

  // Reprogramar por la superficie del bot: 200, no 201.
  const ofertaMover = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const destino = (ofertaMover.json?.slots ?? [])[0];
  if (destino) {
    const movida = await bot("/api/bot/bookings", {
      method: "PATCH",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: destino.startUtc,
      }),
    });
    ok(
      "reprogramar responde 200 (NO 201): no crea un recurso nuevo",
      movida.res.status === 200,
      `status=${movida.res.status}`
    );
  }

  console.log(
    "\n== 015: el mensaje REAL que Max le manda al prospecto (offer_slots) =="
  );
  // Bug reportado en producción: el negocio tenía agenda miércoles, jueves,
  // viernes y lunes, pero el mensaje que Max mandó por WhatsApp solo traía
  // horarios del miércoles. `/api/bot/*` (arriba) ejercita el CATÁLOGO crudo,
  // pero el mensaje que ve el prospecto lo arma `agenda/agent.ts` — otro
  // código, con su propio bug — así que hace falta empujar el camino
  // conversacional REAL: inbound → pipeline del agente in-process → ai-mock.
  //
  // El resto de este guion deja el agente in-process APAGADO a propósito
  // (`enabled: false` en "perfil del agente"), para probar `/api/bot/*` en
  // aislamiento sin que el agente incluido conteste por su cuenta. Aquí se
  // enciende solo para esta sección y se apaga de vuelta al terminar.
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  // Auditoría 2026-09-17 — mismo motivo que LEAD_A/LEAD_B: con el RUN en el
  // teléfono, cada corrida agenda con un contacto NUEVO y el blindaje contra
  // una segunda cita no confunde una corrida anterior con esta.
  const LEAD_MAX = `52146${RUN}04`;
  // El envío sale al teléfono NORMALIZADO (521→52), no al `from` crudo del
  // inbound — mismo criterio que `convA`/`convB` más arriba.
  const LEAD_MAX_NORM = LEAD_MAX.replace(/^521/, "52");
  // Marca de agua del outbox antes de cada inbound: el turno se espera por
  // CONDICIÓN (ver `esperarMensaje`), nunca por reloj.
  let desdeMax = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_MAX,
      name: `Lead agenda Max ${RUN}`,
      text: "quiero agendar una cita",
      waMessageId: `wamid.e2e.015.max.${RUN}.1`,
    }),
  });
  // A diferencia de /api/bot/*, un inbound real pasa por el debounce de
  // AGENT_COALESCE_MS antes de correr el turno: se sondea hasta que el
  // saliente exista, en vez de leer el outbox una sola vez tras una pausa.
  const msgMax = (
    await esperarMensaje(LEAD_MAX, () => true, { desde: desdeMax })
  ).ultimo;

  ok(
    "Max respondió ofreciendo horarios",
    typeof msgMax?.body?.text?.body === "string",
    JSON.stringify(msgMax)
  );
  const textoMax = msgMax?.body?.text?.body ?? "";
  const lineasMax = textoMax.split("\n").filter((l) => l.startsWith("• "));
  ok(
    "el mensaje trae varias opciones de horario",
    lineasMax.length >= 2,
    textoMax
  );
  const diasMax = new Set(lineasMax.map((l) => l.split(" a las ")[0]));
  ok(
    "el mensaje de Max cubre MÁS DE UN DÍA (no repite el mismo día las 3 veces)",
    diasMax.size > 1,
    JSON.stringify(lineasMax)
  );

  // El prospecto lee "9:00 am", no "09:00" — el reloj de 24 h es del panel.
  // Sin esta aserción el guion pasaba igual con el bug puesto: nada más
  // miraba el FORMATO de la hora, solo el día.
  const HORA_12H = /\b\d{1,2}:\d{2} (am|pm)$/;
  ok(
    "cada horario ofrecido termina en am/pm",
    lineasMax.length > 0 && lineasMax.every((l) => HORA_12H.test(l.trim())),
    JSON.stringify(lineasMax)
  );

  console.log(
    "\n== Auditoría 2026-09-17: el blindaje contra una SEGUNDA cita para el mismo contacto =="
  );
  // Bug reportado: un prospecto pidió mover su cita del jueves al viernes, Max
  // derivó esa petición, pero después — hablando de otra cosa — agendó OTRA
  // cita para el mismo jueves. El blindaje tiene que vivir en el SERVIDOR: las
  // instrucciones de prompt son una capa de comportamiento, no un control
  // transaccional, así que este guion reproduce justo el camino que las
  // saltaría (el modelo volviendo a llamar book_slot) y afirma que el
  // servidor, no el modelo, es quien lo detiene.
  desdeMax = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_MAX,
      name: `Lead agenda Max ${RUN}`,
      text: "sí, agenda el primero",
      waMessageId: `wamid.e2e.015.max.${RUN}.2`,
    }),
  });
  await esperarMensaje(LEAD_MAX, () => true, { desde: desdeMax });

  const convsMax1 = (await api("/api/conversations")).json?.conversations ?? [];
  const convMax = convsMax1.find((c) => c.contact.phone === LEAD_MAX_NORM);
  ok("la conversación de Max quedó localizable", Boolean(convMax));

  const bookingsTrasMax1 = (await api("/api/bookings")).json?.bookings ?? [];
  const activasMax1 = convMax
    ? bookingsTrasMax1.filter(
        (b) =>
          b.contact?.id === convMax.contact.id &&
          (b.status === "agendada" || b.status === "realizada")
      )
    : [];
  ok(
    "Max agendó UNA cita real para el prospecto",
    activasMax1.length === 1,
    JSON.stringify(activasMax1.map((b) => b.id))
  );

  // Ni una sola hora en 24 h en TODA la conversación: el menú, la
  // confirmación y cualquier recordatorio hablan del mismo reloj. La
  // confirmación la redacta el modelo (`reply`), así que aquí no se puede
  // exigir que NOMBRE una hora — lo que sí se exige es que, si la nombra, no
  // sea "09:00". El reloj de 24 h se queda en el panel.
  const outboxConfirm = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  const dichosAMax = outboxConfirm
    .filter((o) => o.to === LEAD_MAX_NORM)
    .map((o) => o.body?.text?.body ?? "");
  const conReloj24h = dichosAMax.filter((t) =>
    /\b\d{1,2}:\d{2}(?!\s*(am|pm))/i.test(t)
  );
  ok(
    "ningún mensaje al prospecto usa el reloj de 24 h",
    conReloj24h.length === 0,
    JSON.stringify(conReloj24h)
  );

  // El prospecto pide MOVER esa cita: se registra el cambio pendiente y se
  // deriva a una persona — nunca se agenda otra vez por su cuenta.
  desdeMax = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_MAX,
      name: `Lead agenda Max ${RUN}`,
      text: "quiero mover mi cita a otro día",
      waMessageId: `wamid.e2e.015.max.${RUN}.3`,
    }),
  });
  await esperarMensaje(LEAD_MAX, () => true, { desde: desdeMax });

  // El traspaso y su aviso se persisten en pasos distintos: se sondea el
  // desenlace en la conversación en vez de suponer que ya está escrito.
  const convMaxTrasPedido = await esperarConversacion(
    (cs) => cs.find((c) => c.id === convMax?.id),
    (c) => c.handoffReason === "reprogramacion"
  );
  ok(
    "pedir mover la cita deriva a una persona (handoff), NO la agenda de nuevo",
    convMaxTrasPedido?.handoffReason === "reprogramacion",
    JSON.stringify(convMaxTrasPedido)
  );

  // El dueño "atiende" el chat y reactiva la IA — como pasa en producción
  // cuando el operador contesta y la conversación sigue por otro tema.
  await api(`/api/conversations/${convMax.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });

  // El prospecto sigue hablando y, en algún punto (un bug del modelo, una
  // respuesta ambigua — exactamente lo que se reportó), Max vuelve a intentar
  // agendar. El blindaje del SERVIDOR es lo único que no debe permitir una
  // segunda cita mientras el cambio de horario sigue pendiente.
  desdeMax = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_MAX,
      name: `Lead agenda Max ${RUN}`,
      text: "quiero agendar una cita",
      waMessageId: `wamid.e2e.015.max.${RUN}.4`,
    }),
  });
  await esperarMensaje(LEAD_MAX, () => true, { desde: desdeMax });
  desdeMax = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_MAX,
      name: `Lead agenda Max ${RUN}`,
      text: "sí, agenda el primero",
      waMessageId: `wamid.e2e.015.max.${RUN}.5`,
    }),
  });
  const ultimoMax = (
    await esperarMensaje(LEAD_MAX, () => true, { desde: desdeMax })
  ).ultimo;

  const bookingsTrasMax2 = (await api("/api/bookings")).json?.bookings ?? [];
  const activasMax2 = bookingsTrasMax2.filter(
    (b) =>
      b.contact?.id === convMax?.contact.id &&
      (b.status === "agendada" || b.status === "realizada")
  );
  ok(
    "el blindaje bloquea la segunda cita: SIGUE habiendo solo UNA activa para el contacto",
    activasMax2.length === 1,
    `activas=${activasMax2.length} ids=${JSON.stringify(activasMax2.map((b) => b.id))}`
  );

  ok(
    "el mensaje al prospecto avisa de la cita existente, NUNCA confirma una nueva",
    typeof ultimoMax?.body?.text?.body === "string" &&
      !/¡listo!/i.test(ultimoMax.body.text.body),
    JSON.stringify(ultimoMax)
  );

  console.log(
    "\n== escribiendo…: el prospecto ve que le están contestando =="
  );
  // Hasta el 2026-09-21 el agente in-process no señalaba NADA: ~6 s de
  // debounce más toda la latencia del modelo en silencio, y luego el mensaje
  // de golpe. La capacidad existía pero atrapada en un route del bot externo.
  // `coalesceTyping` se declara más abajo en esta función; aquí se lee aparte.
  const coalesceTyping = Number(process.env.AGENT_COALESCE_MS ?? 6000);
  const LEAD_TYPING = `52146${RUN}09`;
  const LEAD_TYPING_NORM = LEAD_TYPING.replace(/^521/, "52");

  async function señales() {
    return (await api("/api/dev/wa-mock/typing")).json?.typingSignals ?? [];
  }
  /** Espera por CONDICIÓN, nunca por reloj. */
  async function esperarSeñal(desdeN, limiteMs) {
    const hasta = Date.now() + limiteMs;
    while (Date.now() < hasta) {
      const nuevas = (await señales()).filter((x) => x.n > desdeN);
      if (nuevas.length > 0) return nuevas;
      await sleep(400);
    }
    return [];
  }

  const marcaSeñal = (await señales()).at(-1)?.n ?? 0;
  const wamidTyping = `wamid.e2e.typing.${RUN}.1`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_TYPING,
      name: `Lead typing ${RUN}`,
      text: "hola, quiero información",
      waMessageId: wamidTyping,
    }),
  });

  // Se mide CUÁNTO tarda, no solo que llegue: el turno también enciende la
  // señal antes de llamar al modelo, así que sin medir el tiempo este check
  // pasaría igual con el enganche de la ingesta desactivado — lo verificamos
  // con un mutante y pasaba en vacío.
  const t0 = Date.now();
  const nuevas = await esperarSeñal(marcaSeñal, coalesceTyping + 4000);
  const tardo = Date.now() - t0;
  ok(
    "un mensaje entrante enciende «escribiendo…» al momento",
    nuevas.length > 0,
    JSON.stringify(nuevas)
  );
  ok(
    "…sin esperar al debounce: llega desde la INGESTA, no desde el turno",
    tardo < coalesceTyping - 1500,
    `tardó ${tardo}ms con un debounce de ${coalesceTyping}ms`
  );
  ok(
    "…sobre el mensaje correcto, y con el indicador (no solo el leído)",
    nuevas.some((x) => x.messageId === wamidTyping && x.typing === "text"),
    JSON.stringify(nuevas)
  );

  // Con la IA pausada atiende una persona: señalar sería mentirle al cliente.
  const convTyping = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.phone === LEAD_TYPING_NORM
  );
  await api(`/api/conversations/${convTyping?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  const marcaPausa = (await señales()).at(-1)?.n ?? 0;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_TYPING,
      name: `Lead typing ${RUN}`,
      text: "sigo por aquí",
      waMessageId: `wamid.e2e.typing.${RUN}.2`,
    }),
  });
  await sleep(coalesceTyping + 3000);
  ok(
    "con la IA pausada NO se enciende: atiende una persona",
    (await señales()).filter((x) => x.n > marcaPausa).length === 0,
    JSON.stringify((await señales()).filter((x) => x.n > marcaPausa))
  );

  console.log(
    "\n== Incidente 2026-09-20: pedir OTRO DÍA deja de repetir los mismos tres =="
  );
  // El agente ofreció lunes/martes/miércoles a las 09:00, el prospecto pidió
  // "el miércoles pero no a las 9 am" y recibió LOS MISMOS TRES. `offer_slots`
  // no tenía cómo decir "miércoles" y el motor no tenía cómo filtrar.
  const LEAD_DIA = `52146${RUN}08`;
  const LEAD_DIA_NORM = LEAD_DIA.replace(/^521/, "52");
  const NOMBRE_DIA = `Lead otro día ${RUN}`;

  async function turnoDia(texto, n) {
    const desde = await marcaOutbox();
    await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: LEAD_DIA,
        name: NOMBRE_DIA,
        text: texto,
        waMessageId: `wamid.e2e.otrodia.${RUN}.${n}`,
      }),
    });
    return (await esperarMensaje(LEAD_DIA, () => true, { desde })).textoUltimo;
  }
  const bullets = (t) => t.split("\n").filter((l) => l.startsWith("• "));
  const diaDe = (linea) => linea.split(" a las ")[0];
  const horaDe = (linea) => linea.split(" a las ")[1] ?? "";

  const oferta1 = await turnoDia("quiero agendar una cita", 1);
  const b1 = bullets(oferta1);
  ok(
    "la primera oferta cubre varios días",
    new Set(b1.map(diaDe)).size > 1,
    oferta1
  );

  const oferta2 = await turnoDia("otro-dia: el miércoles, pero no a las 9 am", 2);
  const b2 = bullets(oferta2);

  // CONTROL POSITIVO: sin el índice de días en el contexto, el resto de los
  // checks pasarían en vacío.
  ok(
    "CONTROL: el índice de DÍAS llegó al modelo",
    !oferta2.includes("NO-RECIBI-DIAS"),
    oferta2
  );
  ok(
    "la segunda oferta NO es idéntica a la primera",
    b2.length > 0 && b2.join("|") !== b1.join("|"),
    `1=${b1.join("|")} 2=${b2.join("|")}`
  );
  ok(
    "trae varias horas del MISMO día",
    b2.length >= 2 && new Set(b2.map(diaDe)).size === 1,
    oferta2
  );
  ok(
    "no repite las tres horas que el cliente acababa de descartar",
    b2.filter((l) => b1.map(horaDe).includes(horaDe(l))).length < 3,
    `${b1.map(horaDe)} vs ${b2.map(horaDe)}`
  );

  // Camino infeliz: un día que el negocio tiene CERRADO.
  const ajustes = (await api("/api/calendar/settings")).json?.settings ?? {};
  const horarioPrevio = ajustes.weeklyHours;
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ weeklyHours: { ...horarioPrevio, sun: [], sat: [] } }),
  });
  // El próximo domingo, en ISO. TODO en UTC a propósito: mezclar `getDay()`
  // (local) con `toISOString()` (UTC) manda la fecha del lunes siguiente en
  // cuanto hay desfase horario, y el check pasa o falla según la hora a la que
  // corras el arnés.
  const hoy = new Date();
  const domingo = new Date(hoy);
  domingo.setUTCDate(hoy.getUTCDate() + ((7 - hoy.getUTCDay()) % 7 || 7));
  const domingoIso = domingo.toISOString().slice(0, 10);

  const cerrado = await turnoDia(`dia-exacto: ${domingoIso}`, 3);
  ok(
    "un día sin agenda se dice con claridad y con alternativas reales",
    bullets(cerrado).length >= 1,
    cerrado
  );
  ok(
    "…sin pegar encima la intro optimista del modelo",
    !/aquí tienes los horarios de ese día/i.test(cerrado),
    cerrado
  );
  const convDia = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.phone === LEAD_DIA_NORM
  );
  ok("…y sin escalar a un humano por eso", !convDia?.handoffAt, JSON.stringify(convDia?.handoffReason));
  ok(
    "el agente no inventa una restricción de horario",
    !/horario de (la )?ma(ñ|n)ana/i.test(oferta2 + cerrado),
    oferta2 + cerrado
  );

  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ weeklyHours: horarioPrevio }),
  });

  console.log(
    "\n== Incidente 2026-09-19: una cita CANCELADA en el CRM deja de existir para el agente =="
  );
  // El dueño agendó una demo con el agente, la canceló desde la pantalla de
  // Citas, y al escribir de nuevo el agente le respondió "te recuerdo que
  // tienes tu demostración agendada". No consultaba la tabla `booking`: su
  // única fuente era su propio "¡Listo! Te agendé…" del historial.
  const LEAD_CANCEL = `52146${RUN}07`;
  const LEAD_CANCEL_NORM = LEAD_CANCEL.replace(/^521/, "52");
  const NOMBRE_CANCEL = `Lead cita cancelada ${RUN}`;

  async function turnoCancel(texto, n) {
    const desde = await marcaOutbox();
    await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: LEAD_CANCEL,
        name: NOMBRE_CANCEL,
        text: texto,
        waMessageId: `wamid.e2e.cancel.${RUN}.${n}`,
      }),
    });
    return (await esperarMensaje(LEAD_CANCEL, () => true, { desde })).textoUltimo;
  }

  async function citaActivaDe(contactId) {
    const bookings = (await api("/api/bookings")).json?.bookings ?? [];
    return bookings.find(
      (b) =>
        b.contact?.id === contactId &&
        (b.status === "agendada" || b.status === "realizada")
    );
  }

  await turnoCancel("quiero agendar una cita", 1);
  await turnoCancel("sí, agenda el primero", 2);

  const convsCancel = (await api("/api/conversations")).json?.conversations ?? [];
  const convCancel = convsCancel.find((c) => c.contact.phone === LEAD_CANCEL_NORM);
  const citaViva = await citaActivaDe(convCancel?.contact.id);
  ok(
    "el prospecto quedó con una cita activa",
    !!citaViva,
    JSON.stringify(citaViva)
  );

  // CONTROL POSITIVO. Sin este paso, el check de abajo pasaría en verde sin
  // probar nada: bastaría con que el agente nunca hablara de citas.
  const conCita = await turnoCancel("estado-cita: ¿qué tengo?", 3);
  ok(
    "CONTROL: con la cita viva, el agente SÍ la ve en su contexto",
    /te recuerdo que tienes tu cita/i.test(conCita),
    conCita
  );

  // El prospecto pide moverla: queda una solicitud de cambio PENDIENTE, que
  // es lo que luego bloqueaba cualquier cita nueva.
  await turnoCancel("quiero mover mi cita a otro día", 4);
  await api(`/api/conversations/${convCancel?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });

  // EL INCIDENTE: el dueño cancela desde el CRM.
  const cancelRes = await api(`/api/bookings/${citaViva?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  ok("la cita se cancela desde el CRM", cancelRes.res.ok, JSON.stringify(cancelRes.json));
  ok(
    "…y queda 'cancelada' en la base",
    !(await citaActivaDe(convCancel?.contact.id)),
    "todavía aparece una cita activa"
  );

  const sinCita = await turnoCancel("estado-cita: ¿qué tengo?", 5);
  ok(
    "el agente YA NO le recuerda una cita que fue cancelada",
    !/te recuerdo que tienes tu cita/i.test(sinCita),
    sinCita
  );
  ok(
    "…y sabe explícitamente que no hay ninguna",
    /no tienes ninguna cita/i.test(sinCita),
    sinCita
  );

  // La solicitud de cambio huérfana: sin el arreglo, esto responde "voy a
  // confirmar el cambio con el equipo" para siempre y nunca vuelve a agendar.
  await turnoCancel("quiero agendar una cita", 6);
  const trasReagendar = await turnoCancel("sí, agenda el primero", 7);
  ok(
    "cancelar resolvió la solicitud huérfana: se puede volver a agendar",
    !!(await citaActivaDe(convCancel?.contact.id)),
    trasReagendar
  );
  ok(
    "…y el agente NO respondió con la copia de 'cambio pendiente'",
    !/confirmar el cambio con el equipo/i.test(trasReagendar),
    trasReagendar
  );

  // Se apaga de vuelta: el resto del guion asume el agente in-process OFF.
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });

  console.log(
    "\n== Auditoría 2026-09-17 (incidente GRojas/Más Impulso): hechos de la IA no se fusionan ni duplican =="
  );
  // Bug reportado: `update_lead` concatenaba `[IA] {nota}` sin fin al
  // `contact.notes` de texto libre — diez turnos producían diez párrafos
  // acumulativos, mezclando giros de negocio incompatibles bajo el mismo
  // contacto. Este guion reproduce justo eso contra la app real (pipeline
  // in-process + ai-mock + Postgres real) y afirma que `recordAiNote`
  // (server/contacts/notes.ts) lo evita en el SERVIDOR, no solo en el prompt.
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  const LEAD_NOTAS = `52148${RUN}06`;
  // El identity/contact.phone normaliza 521→52 (igual que LEAD_MAX arriba):
  // hay que comparar contra la forma normalizada, no contra el `from` crudo.
  const LEAD_NOTAS_NORM = LEAD_NOTAS.replace(/^521/, "52");
  const NOMBRE_NOTAS = `Lead notas IA ${RUN}`;

  let desdeNotas = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_NOTAS,
      name: NOMBRE_NOTAS,
      text: "giro: plomería. Quiere cotización de tinacos de 300 litros",
      waMessageId: `wamid.e2e.notas.${RUN}.1`,
    }),
  });
  // El hecho se escribe DURANTE el turno: esperar a la respuesta del agente
  // es esperar a que el turno haya terminado de escribirlo.
  await esperarMensaje(LEAD_NOTAS, () => true, { desde: desdeNotas });

  const contactoNotas = (
    (await api("/api/conversations")).json?.conversations ?? []
  ).find((c) => c.contact.phone === LEAD_NOTAS_NORM)?.contact;
  ok("el contacto del guion de notas quedó localizable", Boolean(contactoNotas));

  let detalleNotas = (
    await api(`/api/contacts/${contactoNotas?.id}`)
  ).json;
  ok(
    "el primer hecho queda confirmado con su giro",
    detalleNotas?.aiNotes?.length === 1 &&
      detalleNotas.aiNotes[0]?.status === "confirmed" &&
      detalleNotas.aiNotes[0]?.scenario === "plomería",
    JSON.stringify(detalleNotas?.aiNotes)
  );
  ok(
    "el hallazgo de la IA NUNCA tocó el campo de notas del dueño",
    detalleNotas?.contact?.notes === null || detalleNotas?.contact?.notes === "",
    JSON.stringify(detalleNotas?.contact?.notes)
  );

  // Ráfaga/reintento: el mismo hecho, otra vez. Un mensaje entrante distinto
  // (wa_message_id nuevo) pero el mismo contenido — la deduplicación vive en
  // `contact_note` (hash del texto), no en la idempotencia del webhook.
  desdeNotas = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_NOTAS,
      name: NOMBRE_NOTAS,
      text: "giro: plomería. Quiere cotización de tinacos de 300 litros",
      waMessageId: `wamid.e2e.notas.${RUN}.2`,
    }),
  });
  // El hecho se escribe DURANTE el turno: esperar a la respuesta del agente
  // es esperar a que el turno haya terminado de escribirlo.
  await esperarMensaje(LEAD_NOTAS, () => true, { desde: desdeNotas });

  detalleNotas = (await api(`/api/contacts/${contactoNotas?.id}`)).json;
  ok(
    "el mismo hecho repetido NO produce una segunda fila (dedup real)",
    detalleNotas?.aiNotes?.length === 1,
    JSON.stringify(detalleNotas?.aiNotes)
  );

  // Giro incompatible con el mismo teléfono (justo el patrón del incidente:
  // alguien probando negocios distintos con el mismo contacto real).
  desdeNotas = await marcaOutbox();
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_NOTAS,
      name: NOMBRE_NOTAS,
      text: "giro: clínica dental. Pregunta por limpieza dental",
      waMessageId: `wamid.e2e.notas.${RUN}.3`,
    }),
  });
  // El hecho se escribe DURANTE el turno: esperar a la respuesta del agente
  // es esperar a que el turno haya terminado de escribirlo.
  await esperarMensaje(LEAD_NOTAS, () => true, { desde: desdeNotas });

  detalleNotas = (await api(`/api/contacts/${contactoNotas?.id}`)).json;
  const notaConflicto = detalleNotas?.aiNotes?.find(
    (n) => n.scenario === "clínica dental"
  );
  ok(
    "un giro distinto se guarda como 'conflict', nunca fusionado bajo 'confirmed'",
    notaConflicto?.status === "conflict",
    JSON.stringify(detalleNotas?.aiNotes)
  );
  ok(
    "el hecho de plomería original sigue 'confirmed' (no se reinterpretó)",
    detalleNotas?.aiNotes?.find((n) => n.scenario === "plomería")?.status ===
      "confirmed",
    JSON.stringify(detalleNotas?.aiNotes)
  );
  ok(
    "en total quedaron 2 hechos (el duplicado del paso anterior no cuenta)",
    detalleNotas?.aiNotes?.length === 2,
    JSON.stringify(detalleNotas?.aiNotes)
  );

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });

  console.log("\n== 015: el operador y el enlace pendiente (US4) ==");
  const bookingId = creada.json?.bookingId;
  const cancelada1 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  const cancelada2 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  ok(
    "cancelar dos veces no falla (idempotente)",
    cancelada1.res.ok && cancelada2.res.ok,
    `${cancelada1.res.status}/${cancelada2.res.status}`
  );

  // Una cita cancelada NO debe seguir ofreciendo "agrégala a tu calendario"
  // con datos que ya no son ciertos — ni la página, ni el .ics deben verse
  // como si la cita siguiera en pie.
  const confCancelBody = await (await fetch(creada.json.confirmationUrl)).text();
  ok(
    "la página de confirmación de una cita CANCELADA lo dice explícito",
    /cancel/i.test(confCancelBody),
    "no se encontró aviso de cancelación en la página"
  );
  ok(
    "…y YA NO ofrece los botones de Google/Outlook (serían datos viejos)",
    !confCancelBody.includes("calendar.google.com/calendar/render") &&
      !confCancelBody.includes("outlook.live.com"),
    "los botones de agregar al calendario seguían presentes tras cancelar"
  );
  const icsCancelRes = await fetch(creada.json.calendarUrl);
  const icsCancelBody = await icsCancelRes.text();
  ok(
    "el .ics de una cita cancelada se publica como CANCELLED (METHOD:CANCEL)",
    icsCancelRes.status === 200 &&
      icsCancelBody.includes("STATUS:CANCELLED") &&
      icsCancelBody.includes("METHOD:CANCEL") &&
      // MISMO UID: es lo que le permite a un cliente de calendario que ya
      // había guardado la cita reconciliar la cancelación con ese evento.
      icsCancelBody.includes(`UID:${bookingId}@vocero`),
    icsCancelBody
  );

  const reintentoInvalido = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "retry_link" }),
  });
  ok(
    "reintentar el enlace de una cita que sí lo tiene → 422",
    reintentoInvalido.res.status === 422,
    `status=${reintentoInvalido.res.status}`
  );

  // El conector caído: la cita SE CREA igual, con el enlace pendiente.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "zoom" }),
  });
  const ofertaPend = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotPend = (ofertaPend.json?.slots ?? [])[0];
  if (slotPend) {
    const sinProveedor = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: slotPend.startUtc,
      }),
    });
    ok(
      "con el proveedor sin conectar, la cita SE CREA igual (201)",
      sinProveedor.res.status === 201,
      `status=${sinProveedor.res.status}`
    );
    ok(
      "…y avisa que el enlace queda pendiente, en vez de prometerlo",
      sinProveedor.json?.linkPending === true &&
        sinProveedor.json?.meetingLink === null,
      JSON.stringify(sinProveedor.json)
    );

    const listaPend = (await api("/api/bookings")).json?.bookings ?? [];
    ok(
      "la cita sin enlace se ve como tal en Citas",
      listaPend.some(
        (b) => b.id === sinProveedor.json?.bookingId && b.linkPending === true
      )
    );
  }

  // Se restaura el conector soberano para no dejar la instancia a medias.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "enlace-fijo" }),
  });

  console.log("\n== 015: conector Zoom contra su mock ==");
  const zoomMockUp = await fetch(`${BASE}/api/dev/zoom-mock/_state`);
  if (!zoomMockUp.ok) {
    console.log("  (zoom-mock no disponible: se omiten los checks del conector)");
  } else {
    await fetch(`${BASE}/api/dev/zoom-mock/_reset`, { method: "POST" });

    const malas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-invalid",
      }),
    });
    ok(
      "credenciales que el proveedor rechaza NO se guardan (422)",
      malas.res.status === 422,
      `status=${malas.res.status}`
    );
    ok(
      "…y la conexión sigue sin existir",
      (await api("/api/settings/zoom")).json?.connection === null
    );

    const buenas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-bueno",
      }),
    });
    ok("credenciales válidas se guardan", buenas.res.ok, `status=${buenas.res.status}`);
    ok(
      "hacia el navegador solo salen los últimos 4 del secreto",
      buenas.json?.connection?.secretLast4 === "ueno" &&
        !JSON.stringify(buenas.json).includes("secreto-bueno"),
      JSON.stringify(buenas.json)
    );

    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "zoom" }),
    });
    const ofertaZoom = await bot(
      `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
    );
    const slotZoom = (ofertaZoom.json?.slots ?? [])[0];
    if (slotZoom) {
      const conZoom = await bot("/api/bot/bookings", {
        method: "POST",
        body: JSON.stringify({
          conversationId: convB.id,
          startUtc: slotZoom.startUtc,
        }),
      });
      ok(
        "agendar con Zoom crea la reunión y devuelve su enlace",
        conZoom.res.status === 201 &&
          typeof conZoom.json?.meetingLink === "string" &&
          conZoom.json.meetingLink.includes("zoom.mock"),
        JSON.stringify(conZoom.json)
      );

      const estado = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        // Mismo título configurado en Ajustes → Agenda que ve el .ics y los
        // enlaces de Google/Outlook (`bookingCopy`), NUNCA el nombre de la
        // organización (placeholder de setup) ni el del contacto.
        "el proveedor recibió la reunión con el título configurado y su hora",
        estado.meetings?.length === 1 &&
          estado.meetings[0].topic === "Llamada inicial | Más Impulso Digital",
        JSON.stringify(estado.meetings)
      );

      // Cancelar borra la reunión en el proveedor.
      await api(`/api/bookings/${conZoom.json.bookingId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      const estado2 = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "cancelar la cita borra la reunión en el proveedor",
        (estado2.deleted ?? []).length === 1,
        JSON.stringify(estado2)
      );
    }

    await api("/api/settings/zoom", { method: "DELETE" });
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "enlace-fijo" }),
    });
  }

  // El sandbox del Laboratorio (una cita de prueba jamás llega a un conector)
  // NO se verifica aquí: las conversaciones del Laboratorio no son alcanzables
  // desde la API pública —a propósito—, así que desde fuera solo podría
  // observarse por ausencia, que es una prueba débil. Vive en
  // `tests/unit/agenda-sandbox.test.ts`, que afirma lo que de verdad importa:
  // que el conector no se llama, ni al crear, ni al reprogramar, ni al
  // cancelar.

  // Y se cierra la puerta al salir: las citas que esta corrida agendó se
  // cancelan, para que la siguiente encuentre la agenda libre.
  await cancelarCitasDelArnes("de esta corrida");
}

main().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API (tests/e2e/us-atribucion.md)
 *
 * Cubre las dos configuraciones de la bandera, la conexión del dataset, la
 * captura del anuncio, los dos eventos con la FORMA de su payload, el dedup,
 * y —lo que más importa— que un fallo de Meta jamás cuesta el movimiento del
 * lead.
 *
 * Los contactos llevan un sufijo por corrida: el dedup de conversiones es
 * permanente por diseño, así que re-correr el arnés contra la MISMA base
 * tiene que estrenar leads o estaría midiendo los de la corrida anterior.
 * ============================================================ */

async function atribucionChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52155${SUF}${n}`;
  const nom = (base) => `${base} ${SUF}`;

  console.log("\n== 016: la bandera de la atribución ==");

  if (!encendida) {
    for (const ruta of ["/api/settings/capi", "/api/settings/capi/events"]) {
      const { res } = await api(ruta);
      ok(
        `${ruta} → 404 con la atribución apagada`,
        res.status === 404,
        `status=${res.status}`
      );
    }
    const put = await api("/api/settings/capi", {
      method: "PUT",
      body: JSON.stringify({ datasetId: "ds-e2e" }),
    });
    ok(
      "PUT /api/settings/capi → 404 con la atribución apagada",
      put.res.status === 404,
      `status=${put.res.status}`
    );
    const page = await fetch(`${BASE}/settings/ads`, { headers: { cookie } });
    ok(
      "la pantalla /settings/ads no existe",
      page.status === 404,
      `status=${page.status}`
    );

    // Y un mensaje que SÍ viene de un anuncio se atiende como cualquier otro:
    // la instancia que no atribuye no se entera del referral, pero tampoco se
    // rompe con él.
    const inb = await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel("1"),
        name: nom("Lead con anuncio apagada"),
        text: "vi su anuncio",
        ctwaClid: "clid-apagada",
        waMessageId: `wamid.e2e.016.off.${SUF}`,
      }),
    });
    ok("inbound con anuncio entregado igual", inb.res.ok);
    await sleep(1400);
    const convsOff = (await api("/api/conversations")).json?.conversations ?? [];
    ok(
      "la conversación del anuncio existe (la ingesta no se rompe)",
      convsOff.some((c) => c.contact.name === nom("Lead con anuncio apagada"))
    );
    console.log(
      "  (atribución apagada: el resto de los checks de 016 no aplican)"
    );
    return;
  }

  /* ---------------- US2: conectar el dataset ---------------- */

  console.log("\n== 016: conectar el dataset (US2) ==");
  // Se parte de desconectado: así el primer check afirma lo que dice afirmar
  // aunque el arnés se re-corra sobre la misma base.
  await api("/api/settings/capi", { method: "DELETE" });
  const vacio = await api("/api/settings/capi");
  ok(
    "sin configurar responde 200 con capi: null (no 404)",
    vacio.res.status === 200 && vacio.json?.capi === null,
    JSON.stringify(vacio.json)
  );

  const board0 = (await api("/api/pipeline/board")).json;
  const etapaCalificado = board0.stages.filter((s) => s.kind === "open").at(-1);
  const etapaGanada = board0.stages.find((s) => s.kind === "won");
  const etapaInicial = board0.stages.find((s) => s.kind === "open");

  const etapaAjena = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: "stg_de_otro_negocio",
    }),
  });
  ok(
    "una etapa que no es del negocio se rechaza con 422 etapa_invalida",
    etapaAjena.res.status === 422 &&
      etapaAjena.json?.error?.code === "etapa_invalida",
    `status=${etapaAjena.res.status} ${JSON.stringify(etapaAjena.json)}`
  );

  const guardado = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  ok(
    "se guarda el dataset sin pegar token",
    guardado.res.ok,
    `status=${guardado.res.status}`
  );

  const cfg = (await api("/api/settings/capi")).json?.capi;
  ok(
    "reusó el token de WhatsApp y solo muestra sus últimos 4",
    cfg?.datasetId === "ds-e2e" && cfg?.tokenLast4 === "-e2e",
    JSON.stringify(cfg)
  );
  ok(
    "el token completo NUNCA sale del servidor",
    !JSON.stringify(cfg).includes("tok-e2e"),
    JSON.stringify(cfg)
  );

  /* ---------------- US3 + US4: capturar y calificar ---------------- */

  console.log("\n== 016: del anuncio al lead calificado (US3/US4) ==");
  await api("/api/dev/wa-mock/capi-events", { method: "DELETE" });

  const CLID = `clid-e2e-${SUF}`;
  const NOMBRE_AD = nom("Lead de anuncio");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "hola, vengo del anuncio",
      ctwaClid: CLID,
      adHeadline: "Kit de verano",
      waMessageId: `wamid.e2e.016.ad.${SUF}.1`,
    }),
  });
  await sleep(1400);

  // Segundo mensaje con OTRO referral: el primero gana y no se sobreescribe.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "sigo aquí",
      ctwaClid: "clid-que-no-debe-ganar",
      waMessageId: `wamid.e2e.016.ad.${SUF}.2`,
    }),
  });
  await sleep(1200);

  const board1 = (await api("/api/pipeline/board")).json;
  const leadAd = board1.leads.find((l) => l.contact.name === NOMBRE_AD);
  ok("el lead del anuncio existe en el tablero", !!leadAd);

  const mov1 = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "el lead se mueve a la etapa calificada",
    mov1.res.ok,
    `status=${mov1.res.status}`
  );
  await sleep(800);

  const act1 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const calificado = act1.find(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "se reportó QualifiedLead con acuse de Meta",
    calificado?.status === "sent" && !!calificado?.fbTraceId,
    JSON.stringify(calificado)
  );
  ok(
    "la actividad dice de qué anuncio vino",
    calificado?.adHeadline === "Kit de verano",
    JSON.stringify(calificado)
  );

  const capi1 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento1 = capi1.find((e) => e.eventName === "QualifiedLead");
  ok(
    "el evento viajó con el ctwa_clid del PRIMER referral",
    evento1?.ctwaClid === CLID,
    JSON.stringify(evento1?.ctwaClid)
  );
  ok(
    "y con custom_data.lead_stage (lo único reglable en Meta)",
    evento1?.customData?.lead_stage === "qualified",
    JSON.stringify(evento1?.customData)
  );

  // Dedup: sacarlo y volverlo a meter no re-reporta.
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaInicial.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act2 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const califsDeEste = act2.filter(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "volver a calificar NO reporta dos veces",
    califsDeEste.length === 1,
    `${califsDeEste.length} filas`
  );

  /* ---------------- US5: la venta ---------------- */

  console.log("\n== 016: la venta (US5) ==");
  const venta = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      stageId: etapaGanada.id,
      amountCents: 45050,
      currency: "MXN",
    }),
  });
  ok("el trato se marca como ganado", venta.res.ok, `status=${venta.res.status}`);
  await sleep(800);

  const act3 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const compra = act3.find(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok("se reportó la venta", compra?.status === "sent", JSON.stringify(compra));

  const capi2 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento2 = capi2.find((e) => e.eventName === "Purchase");
  ok(
    "la venta viajó en UNIDADES de la moneda, no en centavos",
    evento2?.customData?.value === 450.5 &&
      evento2?.customData?.currency === "MXN",
    JSON.stringify(evento2?.customData)
  );

  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaGanada.id }),
  });
  await sleep(800);
  const act4 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const comprasDeEste = act4.filter(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok(
    "re-ganar NO manda una segunda compra (a Meta no se le des-envía nada)",
    comprasDeEste.length === 1,
    `${comprasDeEste.length} filas`
  );

  /* ---------------- Los caminos infelices ---------------- */

  console.log("\n== 016: caminos infelices ==");

  // Un lead que no vino de un anuncio: se registra el motivo y nada falla.
  const NOMBRE_ORG = nom("Lead organico");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("3"),
      name: NOMBRE_ORG,
      text: "hola",
      waMessageId: `wamid.e2e.016.org.${SUF}`,
    }),
  });
  await sleep(1400);
  const board2 = (await api("/api/pipeline/board")).json;
  const leadOrg = board2.leads.find((l) => l.contact.name === NOMBRE_ORG);
  await api(`/api/pipeline/leads/${leadOrg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act5 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const omitido = act5.find((e) => e.contactName === NOMBRE_ORG);
  ok(
    "un lead sin anuncio queda OMITIDO con el motivo escrito",
    omitido?.status === "skipped" && /ctwa_clid/.test(omitido?.error ?? ""),
    JSON.stringify(omitido)
  );

  // Meta rechazando: el 200 mentiroso (events_received: 0).
  const NOMBRE_FAIL = nom("Lead con Meta caido");
  await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e-fail",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("4"),
      name: NOMBRE_FAIL,
      text: "vengo del anuncio",
      ctwaClid: `clid-fail-${SUF}`,
      waMessageId: `wamid.e2e.016.fail.${SUF}`,
    }),
  });
  await sleep(1400);
  const board3 = (await api("/api/pipeline/board")).json;
  const leadFail = board3.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  const movFail = await api(`/api/pipeline/leads/${leadFail.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "con Meta rechazando, el lead SE MUEVE igual",
    movFail.res.ok,
    `status=${movFail.res.status}`
  );
  await sleep(800);
  const board4 = (await api("/api/pipeline/board")).json;
  const leadFail2 = board4.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  ok(
    "y se queda en la etapa a la que lo movieron",
    leadFail2?.stageId === etapaCalificado.id,
    JSON.stringify(leadFail2?.stageId)
  );
  const act6 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const fallido = act6.find((e) => e.contactName === NOMBRE_FAIL);
  ok(
    "la fila queda FALLIDA con lo que dijo Meta (200 pero events_received=0)",
    fallido?.status === "failed" &&
      /events_received=0/.test(fallido?.error ?? ""),
    JSON.stringify(fallido)
  );

  // Desconectar: deja de reportarse, pero la bitácora de lo ya dicho se queda.
  const del = await api("/api/settings/capi", { method: "DELETE" });
  ok("se puede desconectar", del.res.ok);
  const trasBorrar = (await api("/api/settings/capi")).json;
  ok("tras desconectar, no hay configuración", trasBorrar?.capi === null);
  const act7 = (await api("/api/settings/capi/events")).json?.events ?? [];
  ok(
    "los eventos ya reportados NO se borran al desconectar",
    act7.length >= 3,
    `${act7.length} filas`
  );
}

/* ============================================================
 * 019 — Cotizaciones (tests/e2e/us-cotizaciones.md)
 *
 * Cubre las dos configuraciones de la bandera, el cálculo de totales en el
 * servidor, la máquina de estados con sus códigos EXACTOS, "vencida" como
 * vista y no como estado guardado, y —lo que más importa— que el webhook
 * hacia n8n es best-effort: un receptor caído jamás cuesta la transición.
 * ============================================================ */

async function quotesChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.QUOTES ?? "").trim()
  );

  console.log("\n== 019: la bandera de cotizaciones ==");

  if (!encendida) {
    const { res } = await api("/api/quotes");
    ok(
      "GET /api/quotes → 404 con QUOTES apagada",
      res.status === 404,
      `status=${res.status}`
    );
    const post = await api("/api/quotes", {
      method: "POST",
      body: JSON.stringify({ leadId: "x", items: [] }),
    });
    ok(
      "POST /api/quotes → 404 con QUOTES apagada",
      post.res.status === 404,
      `status=${post.res.status}`
    );
    const page = await fetch(`${BASE}/quotes`, { headers: { cookie } });
    ok("la pantalla /quotes no existe", page.status === 404, `status=${page.status}`);
    console.log("  (cotizaciones apagadas: el resto de los checks de 019 no aplican)");
    return;
  }

  const listaInicial = await api("/api/quotes");
  ok(
    "GET /api/quotes responde con QUOTES encendida",
    listaInicial.res.ok,
    `status=${listaInicial.res.status}`
  );

  console.log("\n== 019: alta de un lead para cotizar ==");
  const SUF = String(Date.now()).slice(-6);
  const NOMBRE = `Lead cotización ${SUF}`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: `52155${SUF}9`,
      name: NOMBRE,
      text: "quiero una cotización",
      waMessageId: `wamid.e2e.019.${SUF}`,
    }),
  });
  await sleep(1200);
  const board = (await api("/api/pipeline/board")).json;
  const lead = board?.leads?.find((l) => l.contact.name === NOMBRE);
  ok("lead de prueba listo", !!lead);
  if (!lead) return;

  console.log("\n== 019: crear y editar un borrador (US2) ==");
  const sinRenglones = await api("/api/quotes", {
    method: "POST",
    body: JSON.stringify({ leadId: lead.id, items: [] }),
  });
  ok(
    "crear sin renglones → 422",
    sinRenglones.res.status === 422,
    `status=${sinRenglones.res.status}`
  );

  const creada = await api("/api/quotes", {
    method: "POST",
    body: JSON.stringify({
      leadId: lead.id,
      items: [
        { description: "Consultoría", quantity: 2, unitPriceCents: 100000 },
        { description: "Setup", quantity: 1, unitPriceCents: 50000 },
      ],
      discountCents: 10000,
    }),
  });
  ok(
    "crear una cotización responde 201",
    creada.res.status === 201,
    JSON.stringify(creada.json)
  );
  const quoteId = creada.json?.quote?.id;
  ok(
    "los totales se calculan en el SERVIDOR (2×1000 + 500 − 100, en centavos)",
    creada.json?.quote?.subtotalCents === 250000 &&
      creada.json?.quote?.totalCents === 240000,
    JSON.stringify(creada.json?.quote)
  );
  ok("nace en borrador", creada.json?.quote?.status === "borrador");

  const listaLead =
    (await api(`/api/quotes?leadId=${lead.id}`)).json?.quotes ?? [];
  ok(
    "aparece en la lista filtrada por ese trato",
    listaLead.some((q) => q.id === quoteId),
    JSON.stringify(listaLead.map((q) => q.id))
  );

  const editada = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "update",
      items: [
        { description: "Consultoría (ajustada)", quantity: 3, unitPriceCents: 100000 },
      ],
      discountCents: 0,
    }),
  });
  ok(
    "editar un borrador reemplaza renglones y recalcula el total",
    editada.res.ok && editada.json?.quote?.totalCents === 300000,
    JSON.stringify(editada.json)
  );

  console.log("\n== 019: la máquina de estados (US3) ==");
  const saltoInvalido = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "accept" }),
  });
  ok(
    "borrador → aceptada directo se rechaza (422)",
    saltoInvalido.res.status === 422,
    `status=${saltoInvalido.res.status}`
  );

  const enviada = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "send" }),
  });
  ok(
    "enviar responde ok y queda 'enviada' con sentAt",
    enviada.res.ok &&
      enviada.json?.quote?.status === "enviada" &&
      !!enviada.json?.quote?.sentAt,
    JSON.stringify(enviada.json)
  );

  const editarEnviada = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "update", notes: "no debería poder" }),
  });
  ok(
    "editar una cotización ya enviada → 409 (solo un borrador se edita)",
    editarEnviada.res.status === 409,
    `status=${editarEnviada.res.status}`
  );

  const borrarEnviada = await api(`/api/quotes/${quoteId}`, { method: "DELETE" });
  ok(
    "borrar una cotización ya enviada → 409",
    borrarEnviada.res.status === 409,
    `status=${borrarEnviada.res.status}`
  );

  const reenviar = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "send" }),
  });
  ok(
    "re-enviar algo ya enviado → 422",
    reenviar.res.status === 422,
    `status=${reenviar.res.status}`
  );

  const aceptada = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "accept" }),
  });
  ok(
    "aceptar responde ok y guarda respondedAt",
    aceptada.res.ok &&
      aceptada.json?.quote?.status === "aceptada" &&
      !!aceptada.json?.quote?.respondedAt,
    JSON.stringify(aceptada.json)
  );

  console.log("\n== 019: 'vencida' es una VISTA, no un estado guardado (US3.4) ==");
  const conVencimiento = await api("/api/quotes", {
    method: "POST",
    body: JSON.stringify({
      leadId: lead.id,
      validUntil: new Date(Date.now() - 86_400_000).toISOString(),
      items: [{ description: "Algo con vencimiento", quantity: 1, unitPriceCents: 1000 }],
    }),
  });
  const idVenc = conVencimiento.json?.quote?.id;
  await api(`/api/quotes/${idVenc}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "send" }),
  });
  const leidaVenc = (await api(`/api/quotes/${idVenc}`)).json?.quote;
  ok(
    "se MUESTRA vencida aunque el estado guardado siga 'enviada'",
    leidaVenc?.status === "enviada" && leidaVenc?.displayStatus === "vencida",
    JSON.stringify(leidaVenc)
  );
  const aceptaVencida = await api(`/api/quotes/${idVenc}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "accept" }),
  });
  ok(
    "una 'vencida' se acepta igual — el estado guardado seguía siendo 'enviada'",
    aceptaVencida.res.ok && aceptaVencida.json?.quote?.status === "aceptada"
  );

  console.log("\n== 019: webhook saliente hacia n8n (US4) ==");
  const n8nUrl = process.env.QUOTES_N8N_WEBHOOK_URL;
  const n8nMockUp = await fetch(`${BASE}/api/dev/n8n-mock/inbox`).catch(() => null);
  if (!n8nUrl || !n8nMockUp?.ok) {
    console.log(
      "  (QUOTES_N8N_WEBHOOK_URL sin configurar hacia el mock: se omiten los checks del webhook)"
    );
  } else {
    await fetch(`${BASE}/api/dev/n8n-mock/inbox`, { method: "DELETE" });

    const paraWebhook = await api("/api/quotes", {
      method: "POST",
      body: JSON.stringify({
        leadId: lead.id,
        items: [{ description: "Webhook check", quantity: 1, unitPriceCents: 12345 }],
      }),
    });
    const idWebhook = paraWebhook.json?.quote?.id;
    await api(`/api/quotes/${idWebhook}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "send" }),
    });
    await sleep(300);

    let eventos =
      (await (await fetch(`${BASE}/api/dev/n8n-mock/inbox`)).json())?.events ?? [];
    const evEnviada = eventos.find(
      (e) => e.body?.event === "quote.enviada" && e.body?.quote?.id === idWebhook
    );
    ok(
      "n8n recibió el POST del evento 'quote.enviada'",
      !!evEnviada,
      JSON.stringify(eventos.map((e) => e.body?.event))
    );
    ok(
      "el payload trae los renglones y el total, no solo el id",
      evEnviada?.body?.quote?.totalCents === 12345 &&
        evEnviada?.body?.quote?.items?.[0]?.description === "Webhook check",
      JSON.stringify(evEnviada?.body?.quote)
    );

    const secret = process.env.QUOTES_N8N_WEBHOOK_SECRET;
    if (secret && evEnviada) {
      const { createHmac } = await import("node:crypto");
      const firmaEsperada = `sha256=${createHmac("sha256", secret)
        .update(evEnviada.raw)
        .digest("hex")}`;
      ok(
        "la firma HMAC del body es verificable con el secreto configurado",
        evEnviada.signature === firmaEsperada,
        `esperada=${firmaEsperada} recibida=${evEnviada.signature}`
      );
    }

    const trasEnviar = (await api(`/api/quotes/${idWebhook}`)).json?.quote;
    ok(
      "quote.webhookStatus queda 'sent'",
      trasEnviar?.webhookStatus === "sent",
      JSON.stringify(trasEnviar)
    );

    await api(`/api/quotes/${idWebhook}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "accept" }),
    });
    await sleep(300);
    eventos =
      (await (await fetch(`${BASE}/api/dev/n8n-mock/inbox`)).json())?.events ?? [];
    ok(
      "n8n también recibe 'quote.aceptada'",
      eventos.some(
        (e) => e.body?.event === "quote.aceptada" && e.body?.quote?.id === idWebhook
      ),
      JSON.stringify(eventos.map((e) => e.body?.event))
    );

    console.log("\n== 019: el receptor caído no cuesta la transición ==");
    await fetch(`${BASE}/api/dev/n8n-mock/fail`, { method: "POST" });
    const paraFallo = await api("/api/quotes", {
      method: "POST",
      body: JSON.stringify({
        leadId: lead.id,
        items: [{ description: "Con receptor caído", quantity: 1, unitPriceCents: 100 }],
      }),
    });
    const idFallo = paraFallo.json?.quote?.id;
    const enviarConFallo = await api(`/api/quotes/${idFallo}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "send" }),
    });
    ok(
      "con n8n caído, la transición de estado se confirma IGUAL",
      enviarConFallo.res.ok && enviarConFallo.json?.quote?.status === "enviada",
      JSON.stringify(enviarConFallo.json)
    );
    ok(
      "…y queda registrada como 'failed', con el motivo legible",
      enviarConFallo.json?.quote?.webhookStatus === "failed" &&
        !!enviarConFallo.json?.quote?.webhookError,
      JSON.stringify(enviarConFallo.json?.quote)
    );
    await fetch(`${BASE}/api/dev/n8n-mock/fail`, { method: "DELETE" });
  }

  // Multi-tenancy (US5 del guion) NO se ejercita aquí: el registro público se
  // cierra tras la primera organización (ALLOW_SIGNUP), y este arnés no
  // depende de esa variable para ninguna otra sección. La garantía —
  // `organization_id` NOT NULL + `scoped()` en toda query de dominio, que es
  // justo lo que usan `queries.ts` y `service.ts` de cotizaciones — está
  // cubierta genéricamente en tests/unit/tenant.test.ts.
}

/* ============================================================
 * 020 — Activos de cliente (tests/e2e/us-activos.md)
 *
 * Cubre las dos configuraciones de la bandera y —lo que más importa— que el
 * secreto cifrado NUNCA viaja en una lista o lectura normal, solo por el
 * endpoint dedicado a revelarlo, y que editar sin mandar `secret` no lo toca.
 * ============================================================ */

async function assetsChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ASSETS ?? "").trim()
  );

  console.log("\n== 020: la bandera de activos de cliente ==");

  if (!encendida) {
    const { res } = await api("/api/assets?leadId=x");
    ok(
      "GET /api/assets → 404 con ASSETS apagada",
      res.status === 404,
      `status=${res.status}`
    );
    const post = await api("/api/assets", {
      method: "POST",
      body: JSON.stringify({ leadId: "x", type: "domain", name: "x" }),
    });
    ok(
      "POST /api/assets → 404 con ASSETS apagada",
      post.res.status === 404,
      `status=${post.res.status}`
    );
    const secret = await api("/api/assets/x/secret");
    ok(
      "GET /api/assets/[id]/secret → 404 con ASSETS apagada",
      secret.res.status === 404,
      `status=${secret.res.status}`
    );
    console.log("  (activos apagados: el resto de los checks de 020 no aplican)");
    return;
  }

  console.log("\n== 020: alta de un lead para colgarle activos ==");
  const SUF = String(Date.now()).slice(-6);
  const NOMBRE = `Lead activos ${SUF}`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: `52156${SUF}9`,
      name: NOMBRE,
      text: "hola",
      waMessageId: `wamid.e2e.020.${SUF}`,
    }),
  });
  await sleep(1200);
  const board = (await api("/api/pipeline/board")).json;
  const lead = board?.leads?.find((l) => l.contact.name === NOMBRE);
  ok("lead de prueba listo", !!lead);
  if (!lead) return;

  console.log("\n== 020: alta y lectura nunca exponen el secreto (US2) ==");
  const sinNombre = await api("/api/assets", {
    method: "POST",
    body: JSON.stringify({ leadId: lead.id, type: "domain", name: "" }),
  });
  ok(
    "crear sin nombre → 422",
    sinNombre.res.status === 422,
    `status=${sinNombre.res.status}`
  );

  const leadInexistente = await api("/api/assets", {
    method: "POST",
    body: JSON.stringify({ leadId: "ld_no_existe", type: "domain", name: "x" }),
  });
  ok(
    "crear sobre un lead inexistente → 404",
    leadInexistente.res.status === 404,
    `status=${leadInexistente.res.status}`
  );

  const SECRETO = "clave-super-secreta-" + SUF;
  const creado = await api("/api/assets", {
    method: "POST",
    body: JSON.stringify({
      leadId: lead.id,
      type: "wordpress",
      name: "WP del cliente",
      url: "https://ejemplo.test/wp-admin",
      username: "admin",
      secret: SECRETO,
      notes: "acceso de prueba",
    }),
  });
  ok(
    "crear un activo con secreto responde 201",
    creado.res.status === 201,
    JSON.stringify(creado.json)
  );
  const assetId = creado.json?.asset?.id;
  ok("hasSecret queda true", creado.json?.asset?.hasSecret === true);
  ok(
    "el secreto NUNCA viaja en la respuesta de creación",
    !JSON.stringify(creado.json).includes(SECRETO),
    "el body de creación contenía el texto plano"
  );

  const sinSecreto = await api("/api/assets", {
    method: "POST",
    body: JSON.stringify({ leadId: lead.id, type: "domain", name: "Dominio simple" }),
  });
  ok(
    "un activo sin secreto queda con hasSecret=false",
    sinSecreto.json?.asset?.hasSecret === false
  );

  const lista = (await api(`/api/assets?leadId=${lead.id}`)).json?.assets ?? [];
  ok(
    "la lista trae ambos activos, sin el campo `secret` en ninguno",
    lista.length >= 2 && lista.every((a) => a.secret === undefined),
    JSON.stringify(lista)
  );
  ok(
    "…y sin el secreto en claro en ningún lado del payload",
    !JSON.stringify(lista).includes(SECRETO),
    "la lista contenía el texto plano"
  );

  console.log("\n== 020: revelar la clave es un endpoint aparte (US3) ==");
  const revelado = await api(`/api/assets/${assetId}/secret`);
  ok(
    "GET .../secret devuelve el mismo texto plano que se guardó",
    revelado.res.ok && revelado.json?.secret === SECRETO,
    JSON.stringify(revelado.json)
  );
  const revelarSinSecreto = await api(
    `/api/assets/${sinSecreto.json?.asset?.id}/secret`
  );
  ok(
    "un activo sin secreto revela null, no error",
    revelarSinSecreto.res.ok && revelarSinSecreto.json?.secret === null,
    JSON.stringify(revelarSinSecreto.json)
  );

  console.log("\n== 020: editar sin tocar, borrar o reemplazar el secreto (US4) ==");
  const editarNombre = await api(`/api/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "WP del cliente (renombrado)" }),
  });
  ok(
    "editar sin mandar `secret` no lo toca",
    editarNombre.res.ok && editarNombre.json?.asset?.hasSecret === true,
    JSON.stringify(editarNombre.json)
  );
  const trasEditar = (await api(`/api/assets/${assetId}/secret`)).json?.secret;
  ok(
    "…el valor descifrado sigue siendo el mismo",
    trasEditar === SECRETO,
    `obtuve=${trasEditar}`
  );

  const borrarSecreto = await api(`/api/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ secret: null }),
  });
  ok(
    "PATCH con secret:null lo borra",
    borrarSecreto.res.ok && borrarSecreto.json?.asset?.hasSecret === false,
    JSON.stringify(borrarSecreto.json)
  );
  const trasBorrar = (await api(`/api/assets/${assetId}/secret`)).json?.secret;
  ok("…y revela null", trasBorrar === null, `obtuve=${trasBorrar}`);

  const NUEVO_SECRETO = "otra-clave-" + SUF;
  await api(`/api/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ secret: NUEVO_SECRETO }),
  });
  const trasReemplazar = (await api(`/api/assets/${assetId}/secret`)).json?.secret;
  ok(
    "re-asignar `secret` re-cifra con el nuevo valor",
    trasReemplazar === NUEVO_SECRETO,
    `obtuve=${trasReemplazar}`
  );

  console.log("\n== 020: borrar (US5) ==");
  const borrado = await api(`/api/assets/${assetId}`, { method: "DELETE" });
  ok("borrar responde ok", borrado.res.ok, JSON.stringify(borrado.json));
  const leerBorrado = await api(`/api/assets/${assetId}`);
  ok(
    "leerlo después → 404",
    leerBorrado.res.status === 404,
    `status=${leerBorrado.res.status}`
  );
}

/* ============================================================
 * 021 — Proyectos e hitos (tests/e2e/us-proyectos.md)
 *
 * Cubre las dos configuraciones de la bandera y, sobre todo, que aceptar una
 * cotización abre el proyecto y sus 4 hitos EN LA MISMA operación — no una
 * cola aparte que pueda quedar a medias.
 * ============================================================ */

async function projectsChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.PROJECTS ?? "").trim()
  );

  console.log("\n== 021: la bandera de proyectos ==");

  if (!encendida) {
    const { res } = await api("/api/projects");
    ok(
      "GET /api/projects → 404 con PROJECTS apagada",
      res.status === 404,
      `status=${res.status}`
    );
    const patch = await api("/api/projects/x", {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress" }),
    });
    ok(
      "PATCH /api/projects/[id] → 404 con PROJECTS apagada",
      patch.res.status === 404,
      `status=${patch.res.status}`
    );
    const page = await fetch(`${BASE}/projects`, { headers: { cookie } });
    ok("la pantalla /projects no existe", page.status === 404, `status=${page.status}`);
    console.log("  (proyectos apagados: el resto de los checks de 021 no aplican)");
    return;
  }

  const quotesOn = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.QUOTES ?? "").trim()
  );
  if (!quotesOn) {
    console.log(
      "  (QUOTES apagada: la automatización de 021 no tiene de dónde nacer, se omite)"
    );
    return;
  }

  console.log("\n== 021: alta de un lead sin proyecto todavía (US4) ==");
  const SUF = String(Date.now()).slice(-6);
  const NOMBRE = `Lead proyecto ${SUF}`;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: `52157${SUF}9`,
      name: NOMBRE,
      text: "hola",
      waMessageId: `wamid.e2e.021.${SUF}`,
    }),
  });
  await sleep(1200);
  const board = (await api("/api/pipeline/board")).json;
  const lead = board?.leads?.find((l) => l.contact.name === NOMBRE);
  ok("lead de prueba listo", !!lead);
  if (!lead) return;

  const sinProyecto =
    (await api(`/api/projects?leadId=${lead.id}`)).json?.projects ?? [];
  ok(
    "sin cotización aceptada, no hay proyecto para este trato",
    sinProyecto.length === 0,
    JSON.stringify(sinProyecto)
  );

  console.log("\n== 021: aceptar una cotización abre el proyecto, automático (US2) ==");
  const cotizacion = await api("/api/quotes", {
    method: "POST",
    body: JSON.stringify({
      leadId: lead.id,
      items: [{ description: "Sitio nuevo", quantity: 1, unitPriceCents: 500000 }],
    }),
  });
  const quoteId = cotizacion.json?.quote?.id;
  await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "send" }),
  });
  const aceptada = await api(`/api/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "accept" }),
  });
  ok("aceptar la cotización responde ok", aceptada.res.ok, JSON.stringify(aceptada.json));

  const proyectos =
    (await api(`/api/projects?leadId=${lead.id}`)).json?.projects ?? [];
  ok(
    "nace exactamente un proyecto para ese trato",
    proyectos.length === 1,
    JSON.stringify(proyectos)
  );
  const proyecto = proyectos[0];
  ok(
    "vinculado a la cotización y con su presupuesto/moneda",
    proyecto?.quoteId === quoteId &&
      proyecto?.leadId === lead.id &&
      proyecto?.budgetCents === 500000 &&
      proyecto?.status === "planning",
    JSON.stringify(proyecto)
  );
  ok(
    "trae los 4 hitos fijos, en orden y pendientes",
    JSON.stringify(proyecto?.milestones?.map((m) => m.title)) ===
      JSON.stringify([
        "Recopilación de accesos y materiales",
        "Desarrollo en entorno de Staging / Coolify",
        "Revisión y ajustes del cliente",
        "Lanzamiento en Producción",
      ]) && proyecto?.milestones?.every((m) => m.status === "pending"),
    JSON.stringify(proyecto?.milestones)
  );

  const enListaGeneral = (await api("/api/projects")).json?.projects ?? [];
  ok(
    "también aparece en la lista general (sin filtro)",
    enListaGeneral.some((p) => p.id === proyecto.id)
  );

  console.log("\n== 021: seguimiento del proyecto y sus hitos (US3) ==");
  const cambioEstado = await api(`/api/projects/${proyecto.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress" }),
  });
  ok(
    "cambiar el estado del proyecto",
    cambioEstado.res.ok && cambioEstado.json?.project?.status === "in_progress",
    JSON.stringify(cambioEstado.json)
  );
  const estadoInvalido = await api(`/api/projects/${proyecto.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "no_existe" }),
  });
  ok(
    "un estado fuera del enum → 422",
    estadoInvalido.res.status === 422,
    `status=${estadoInvalido.res.status}`
  );

  const hito1 = proyecto.milestones[0];
  const avance1 = await api(
    `/api/projects/${proyecto.id}/milestones/${hito1.id}`,
    { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) }
  );
  ok(
    "avanzar un hito a en curso",
    avance1.res.ok &&
      avance1.json?.project?.milestones?.find((m) => m.id === hito1.id)?.status ===
        "in_progress",
    JSON.stringify(avance1.json)
  );
  const avance2 = await api(
    `/api/projects/${proyecto.id}/milestones/${hito1.id}`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) }
  );
  const hitosTrasAvance = avance2.json?.project?.milestones ?? [];
  ok(
    "…y a completado, sin tocar los demás hitos",
    hitosTrasAvance.find((m) => m.id === hito1.id)?.status === "completed" &&
      hitosTrasAvance
        .filter((m) => m.id !== hito1.id)
        .every((m) => m.status === "pending"),
    JSON.stringify(hitosTrasAvance)
  );

  const hitoAjeno = await api(
    `/api/projects/${proyecto.id}/milestones/pms_no_existe`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) }
  );
  ok(
    "un milestoneId que no pertenece a ese proyecto → 404",
    hitoAjeno.res.status === 404,
    `status=${hitoAjeno.res.status}`
  );
}
