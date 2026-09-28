# Contrato: Acciones del agente y juez del Laboratorio

## Adaptador LLM (frontera única)

`lib/ai`: cliente `fetch` OpenRouter-compatible. Env: `OPENROUTER_API_TOKEN` (opcional —
sin él, agente/Laboratorio deshabilitados con estado vacío), `OPENROUTER_BASE_URL`
(default `https://openrouter.ai/api`), `OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`
(default = `OPENROUTER_MODEL`). API: `chatJson<T>(schema, messages, opts)` → parsea con
extracción robusta (bloque ```json, primer `{...}`), valida con Zod. **Actualizado por
[023](../../023-respuesta-estructurada-agente/spec.md)**: pide JSON con `response_format`
(`json_schema` estricto → `json_object` → sin formato, según `AI_RESPONSE_FORMAT`), el
esquema JSON se deriva del Zod, y los reintentos dependen de la CLASE de error (429
respeta `Retry-After`; 5xx/red ≤ 2; timeout ≤ 1; formato/esquema ≤ 1 corrección; 4xx
determinista 0). **Presupuesto compartido por turno: ≤ 3 llamadas** (reintentos, bajada de
formato, corrección y recuperación de texto plano descuentan del mismo `CallBudget`); sólo
formato ≤ 2. Sólo un rechazo EXPLÍCITO del proveedor (`param`/`code` estructurados o la
frase de OpenRouter para `require_parameters`) baja de `response_format`; un 400/404/422
genérico es `invalid_request`. Un hipo del proveedor NUNCA propaga excepción al turno: el
resultado `error` lleva un código explícito (`not_configured`, `unauthorized`,
`unsupported_response_format`, `schema_rejected`, `model_not_found`, `invalid_request`,
`rate_limited`, `timeout`, `network_error`, `provider_error`, `invalid_json`,
`invalid_schema`) y un `detail` fijo, sin contenido del cliente ni del modelo. El modelo
efectivo sale de `resolveEffectiveModel` (`GET /api/settings/ai` → `effective`).

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
- `offer_slots` es SOLO para una petición genérica de opciones. En cuanto el
  cliente nombra un día, una fecha, una hora o un rango, la acción es
  `check_availability`, que consulta la agenda COMPLETA con las palabras del
  cliente (`server/agenda/availability-query.ts`) en vez de fiarse de que el
  modelo calcule la fecha. Lo que no se entiende se pregunta
  (`availability_clarify`); tres aclaraciones seguidas sin resolver escalan
  como `agenda_ambigua`.
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
- Ventana cerrada → handoff automático `ventana`. Fallo persistente del proveedor o de
  configuración (transporte/config) → handoff `error`, sin enviar texto libre. Un fallo de
  **formato** (texto plano, JSON inválido) NO es un fallo del proveedor: el texto plano
  seguro se recupera como `reply` (023 §3.4), y si no, se envía un mensaje fijo de
  degradación (`AI_FALLBACK_MESSAGE`) con la IA activa; dos turnos consecutivos así
  (`conversation.ai_fail_count ≥ 2`, contador técnico atómico en la base, independiente del
  texto visible) → handoff `error`. El texto plano JAMÁS ejecuta una acción con efectos.
- Circuito de protección por organización+modelo: con una falla global (config o
  transporte agotado, ≥ 2 conversaciones distintas) los turnos no llaman al proveedor ni
  hacen handoff; la IA sigue activa y el cliente recibe una vez el mensaje fijo (sin
  prometer un humano). Señal: logs `circuit_open|blocked|closed` sin contenido.

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
