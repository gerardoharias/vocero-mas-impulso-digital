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
