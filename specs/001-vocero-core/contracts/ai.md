# Contrato: Acciones del agente y juez del Laboratorio

## Adaptador LLM (frontera única)

`lib/ai`: cliente `fetch` OpenRouter-compatible. Env: `OPENROUTER_API_TOKEN` (opcional —
sin él, agente/Laboratorio deshabilitados con estado vacío), `OPENROUTER_BASE_URL`
(default `https://openrouter.ai/api`), `OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`
(default = `OPENROUTER_MODEL`). API: `chatJson<T>(schema, messages, opts)` → parsea con
extracción robusta (bloque ```json, primer `{...}` balanceado), valida con Zod,
reintenta ante fallo de red/parseo/validación (2 reintentos, backoff corto). Un hipo del
proveedor NUNCA propaga excepción al turno: agota reintentos → resultado `error` tipado.

## Acción del agente (una por turno)

```ts
const AgentAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('none') }),
  z.object({ action: z.literal('reply'), text: z.string().min(1) }),
  z.object({ action: z.literal('update_lead'), note: z.string().trim().min(1).max(300),
             scenario: z.string().trim().min(1).max(80).optional(),
             reply: z.string().optional() }),
  z.object({ action: z.literal('move_stage'), stage: z.string().min(1),
             reply: z.string().optional() }),
  z.object({ action: z.literal('handoff'), reason: z.string().optional(),
             farewell: z.string().optional() }),
])
```

- `move_stage.stage` se resuelve contra nombres de etapas de la org (fuzzy exacto →
  lower-case); sin match → se degrada a `reply` si trae texto, o `none`.
- Auditoría 2026-09-17 (incidente GRojas/Más Impulso) — `update_lead` ya NO escribe en
  `contact.notes` (ese campo es 100% del dueño). Cada nota es UN hecho atómico y va a
  `contact_note` (`server/contacts/notes.ts`, `recordAiNote`), deduplicado por hash y con
  estado `confirmed | test | conflict`: `test` si `conversation.is_test`; `conflict` si
  `scenario` no coincide con el último `scenario` `confirmed` del mismo contacto (giro de
  negocio incompatible con el mismo teléfono — nunca se fusiona bajo `confirmed`). Ninguna
  fila cambia de estado después de creada.
- Regex de respaldo de handoff (se evalúa sobre el mensaje del cliente ANTES del LLM):
  `/(hablar|comunicar|contactar)[\s\S]{0,40}?(asesor|humano|persona|alguien)|un asesor|atenci[oó]n humana/i`
  — "somos 4 personas" NO matchea (unit test).
- Disparadores de turno: ingesta de mensaje entrante en conversación con IA activa
  (global + conversación + sin handoff). Debounce (coalesce) 6s producción / 0 en
  Laboratorio; lock in-process por `conversation_id`; los mensajes que llegan durante el
  turno se re-encolan.
- Presencia: al ingerir un entrante REAL, si el agente va a responder (IA
  configurada, conversación sin handoff y con IA activa, agente encendido), se
  marca leído y se enciende "escribiendo…" en UNA sola llamada a Cloud API
  (`server/whatsapp/presence.ts`). Se re-enciende antes del LLM si la señal ya
  caducó (~25 s en Meta). Best-effort: nunca se reintenta y jamás tumba el
  turno. Sandbox del Laboratorio, canal sin soporte, handoff/IA pausada, sin
  entrante y sin conexión cortan ANTES de tocar la red. Solo WhatsApp declara
  `typingIndicator` en el catálogo de canales.
- Un hueco en el knowledge base NO autoriza traspasar: el prompt exige
  responder con `reply` y seguir la conversación. Escalar queda para las
  reglas de escalado del negocio (o, sin ellas, petición explícita del
  cliente, hostilidad o datos sensibles). Que el cliente nombre una
  herramienta o funcionalidad que no está escrita es justo lo que se resuelve
  hablando, no traspasando.
- Con la agenda encendida, el prompt declara el OBJETIVO: dejar una cita
  agendada. Un dato concreto del cliente (su sistema, su giro, su problema) es
  la señal de avanzar a `offer_slots`. Con el contrapeso explícito de que
  ofrecer no es insistir.
- `offer_slots` acepta un `day` opcional (YYYY-MM-DD): con él el motor devuelve
  varias HORAS de ese día (`pickWithinDay`), sin él el menú normal de varios
  días (`pickAcrossDays`). Sin ese campo, un cliente que pedía otro día recibía
  EXACTAMENTE los mismos horarios. El día que no dé nada responde
  `day_unavailable` con la fecha real y la alternativa más cercana — nunca
  escala. El esquema no valida el formato: `resolveRequestedDay` ignora lo que
  no sea una fecha y ofrece el menú normal.
- El prompt lleva el HORARIO DE ATENCIÓN configurado y la fecha de hoy. Sin
  eso, el modelo dedujo una restricción inexistente ("solo atendemos por la
  mañana") de una muestra de tres huecos.
- El estado volátil (citas vigentes, catálogo de huecos, índice de días) viaja
  en un mensaje `system` DESPUÉS del historial, no dentro del system prompt:
  es lo único que cambia entre turnos y lo único que debe ganarle a lo que el
  agente dijo veinte mensajes atrás.
- Con la agenda encendida, el prompt lleva el bloque ESTADO DE AGENDA: las
  citas vigentes del contacto leídas de la base al armar el turno
  (`server/agenda/agent.ts` → `readAgendaState`), o la afirmación explícita de
  que no tiene ninguna. Ese bloque es la ÚNICA fuente de verdad sobre citas y
  manda sobre el historial, incluidos los mensajes que el propio agente envió:
  sin él, una cita cancelada desde el CRM seguía "viva" para el modelo. El
  Laboratorio lee su propio sandbox (`booking.is_test`), nunca las citas
  reales. Si la lectura falla, el bloque dice que no se pudo verificar — jamás
  degrada a "no tiene cita".
- Si el proveedor no devuelve JSON pero SÍ texto utilizable, ese texto se
  entrega como respuesta (`server/ai/salvage.ts`) en vez de escalar: un hipo de
  formato no cuesta una respuesta. Se descarta —y entonces sí escala— el texto
  vacío, el JSON roto, el eco de un error del proveedor, lo que supera el largo
  del canal más estrecho, y cualquier cosa que contenga un marcador del prompt
  del sistema.
- Ventana cerrada o error persistente del proveedor → handoff automático
  (`handoff_reason: 'ventana' | 'error'`).
- Al escalar, el cliente recibe un aviso de cortesía FIJO del sistema en los
  motivos `error`, `cliente` y `modelo` (este último solo si el modelo no puso
  su propia `farewell`). NO se manda en `ventana` —con la ventana de 24 h
  cerrada está prohibido el texto libre—, ni en `reprogramacion` (tiene el
  suyo), ni en `manual_reply`/`hostilidad`. El aviso sale UNA sola vez: si la
  conversación ya estaba escalada, no se repite.

## Juez del Laboratorio (una llamada por conversación)

Input: transcript completo + KB + comportamiento. Output (Zod):

```ts
const Verdict = z.object({
  veredicto: z.enum(['verde', 'amarillo', 'rojo']),
  hallazgos: z.array(z.object({
    tipo: z.enum(['alucinacion', 'fuera_de_kb', 'debio_escalar', 'tono']),
    evidencia: z.string(),
    sugerencia: z.object({ pregunta: z.string(), respuesta: z.string() }).optional(),
  })),
})
```

Juez inválido tras reintentos → caso `judge_failed` (excluido del score, visible en el
reporte); la corrida continúa.

## Personas guionadas (fijas, sin LLM)

6 claves: `comprador_decidido`, `pregunton_precios`, `cliente_enojado`, `fuera_de_kb`,
`pide_humano`, `errores_modismos`. Cada una: 4–5 mensajes predefinidos; el runner envía
mensaje → espera el turno del agente (pipeline real, debounce 0) → siguiente. Fin del
guion o primer handoff → juez.
