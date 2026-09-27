# 023 — Respuesta estructurada y recuperación segura del agente

> Ver también [024](../024-entrega-integra-mensajes-salientes/spec.md): qué pasa cuando **Meta** no acepta un
> mensaje ya armado (esta spec trata del formato que devuelve *el modelo*; no se solapan).

**Carril**: ciclo completo (Principio VI). La primera versión era carril ligero;
la revisión preproducción (rev. 2, 2026-09-20) añadió la migración `0022`
(estado técnico de fallos por conversación), lo que obliga al ciclo completo:
[`plan.md`](plan.md), [`data-model.md`](data-model.md), [`tasks.md`](tasks.md).
No toca un contrato publicado (`/api/bot/*`, webhook, SSE); sí cambia el
contrato *interno* del adaptador `chatJson` (`specs/001-vocero-core/contracts/ai.md`,
actualizado) y agrega un campo `effective` a `GET /api/settings/ai` (aditivo).

**Estado**: rev. 2 implementada y verificada (unitarias, Postgres real, E2E). La prueba real contra OpenRouter está PREPARADA y pendiente de autorización (§3.10).

**Constitution Check** (antes de escribir código): II Soberanía — sin proveedor
nuevo ni dependencia nueva (se descarta `zod-to-json-schema`, ver D2). I
Seguridad — los logs dejan de llevar contenido del cliente. III/IV — sin
cambios de tenancy ni de idempotencia. Sandbox del Laboratorio — intacto: los
turnos `is_test` siguen sin tocar la API real. Sin violaciones.

## 0. Revisión preproducción (rev. 2, 2026-09-20)

Siete riesgos revisados contra el código de rev. 1; todos confirmados salvo
donde se indica. Las secciones afectadas se reescribieron en su lugar (3.1,
3.2, 3.3, 3.5, 3.6) y se añadieron 3.7–3.10.

| # | Riesgo | Veredicto | Evidencia | Corrección |
|---|---|---|---|---|
| 1 | Presupuesto de llamadas | **Confirmado** | Barrido de 1 296 secuencias de respuestas sobre el pipeline real: **peor caso 6 llamadas** en un turno (`plain,e500,e500,e400`): cada capa (chatJson 5, recuperación aparte) tenía su tope | Un presupuesto por turno, compartido (§3.3): ≤ 3 llamadas; sólo formato ≤ 2 |
| 2 | Bajar de formato ante cualquier 400/404/422 | **Confirmado** | `formatCandidate` era `status ∈ {400,404,422}` | Clasificación estructurada (§3.1): sólo señal explícita baja; el resto es error visible |
| 3 | Detección de consecutivos por texto exacto | **Confirmado** | `lastOut.text === fallback` | Columnas `conversation.ai_fail_*` + SQL atómico (§3.6, migración 0022) |
| 4 | Sin protección ante fallo global | **Confirmado** | Cada conversación pagaba sus llamadas y terminaba en su propio handoff `error` | Circuito por organización+modelo (§3.7) |
| 5 | Modelo real | **Parcialmente**: el código no fija ningún modelo por defecto; `anthropic/claude-sonnet-4.5` sólo aparece en documentación como ejemplo | `resolveEffectiveModel` (nuevo) unifica la precedencia | §3.8 + diagnóstico en `GET /api/settings/ai` |
| 6 | Conversor Zod→JSON Schema | **Confirmado el hueco** (sin registro ni prueba de contrato); dos defectos menores corregidos | `anyOf` anidado en el sobre; `transcriptSchema` no exportado | §3.9: registro + prueba de contrato + escaneo del código |
| 7 | Prueba real | Pendiente por diseño | — | §3.10: preparada con triple candado, **no ejecutada** |

Hallazgos adicionales durante la revisión (corregidos): la memoria del nivel de
formato refrescaba su TTL en cada acierto (nunca caducaba); un `Date` dentro de
un `sql\`\`` crudo no se codifica en postgres-js — lo destapó la verificación
contra Postgres real, que las pruebas con la base simulada no podían ver.

### Cierre preproducción (rev. 3, 2026-09-20)

1. **E2E `offer_slots` en frío: causa medida y corregida.** Aislado en
   `scripts/e2e-offer-slots-cold.mjs` (servidor NUEVO por iteración): 10/10
   arranques en frío superaron la espera fija de 9 s (mensaje a los
   **14.2-34.8 s** del inbound; en caliente 7.2-9.4 s). Causa: `next dev`
   compila bajo demanda las rutas que toca el turno (`/api/dev/ai-mock/...`
   2.6-4.7 s, `/api/webhooks/wa/...` ~2 s, `wa-mock/inbound`): **espera fija
   insuficiente + compilación en frío del servidor de desarrollo**. No es una
   carrera del código ni un problema de agenda/outbox: el mensaje llega siempre,
   con 3 opciones en 3 días distintos. Corrección: `waitFor` / `waitTurn` /
   `waitConversation` en el E2E (condición observable: mensaje saliente nuevo o
   traspaso aplicado, tope 90 s) en las 9 esperas de turnos de agente. Hallazgo
   aparte, misma clase: el `sleep(1600)` de la descarga de adjuntos (sección
   008) falló una vez en frío; corregido igual.
2. **Migración 0022 endurecida** (`data-model.md`): `SET LOCAL lock_timeout`.
3. **Prueba real**: costo, variables, comando y criterios en 3.10; `maxTokens`
   opt-in en `chatJson`.

## 1. Problema y causa raíz

Incidente real: ante una pregunta fuera de alcance, Max respondió bien (sólo
CRM, y propuso seguir con la demo), pero en **texto plano**. El CRM descartó la
respuesta, hizo **3 llamadas** al proveedor y **escaló a un humano** con motivo
`error`.

Causas raíz (confirmadas leyendo el código, no supuestas):

1. `callProvider` envía sólo `{ model, messages }` (`src/lib/ai/index.ts`): no
   hay `response_format`; el formato depende de que el modelo obedezca el prompt.
2. `chatJson` trata **todo** fallo igual: 3 intentos idénticos (+ un mensaje
   `STRICT`) tanto para un 429 como para "el modelo contestó en prosa" o un
   error 4xx determinista (token inválido, parámetro no soportado).
3. `chatJson` clasifica el error buscando las palabras `"esquema"`/`"JSON"` en
   el texto del mensaje (`lastDetail.includes(...)`): frágil, y todo lo demás
   cae en `provider_error`.
4. `pipeline.ts` colapsa cualquier `!result.ok` (salvo `not_configured`) en
   `applyHandoff(..., "error")`: un problema de **presentación** apaga la IA de
   la conversación hasta que alguien la reactive, sin avisar al cliente.
5. `detail` incluye `raw=<300 caracteres de la respuesta del modelo>` y el
   pipeline lo manda a `console.error`: fragmentos de la conversación del
   prospecto terminan en los logs. Igual en `judge.ts` y, vía
   `transcribeAudio → result.detail`, en `media.ts` (texto de la nota de voz).

## 2. Flujo actual (evidencia)

`mensaje entrante → scheduleAgentTurn (coalesce) → runAgentTurn → prompt
(buildAgentSystemPrompt + historial 20 msgs) → chatJson(agentActionSchema) →
callProvider({model,messages}) → extractJson (fence | texto | primer{…último})
→ Zod → [falla] hasta 3 intentos con "STRICT" → [agota] applyHandoff("error")
→ [ok] acción: reply/none/update_lead/move_stage/handoff/offer_slots/book_slot/
request_reschedule`.

Consumidores de `chatJson`/adaptador (grep completo): `pipeline.ts` (agente),
`lab/judge.ts` (juez), `transcribeAudio` (dentro de `lib/ai`, usada por
`whatsapp/media.ts`), `testAiCredentials` (usa `callProvider` directo, sin
JSON). `applyHandoff` se llama con `ventana`, `cliente`, `error`,
`reprogramacion`, `modelo`. Nada usa `ChatJsonResult.raw`.

| Llamada | Necesita | Hoy |
|---|---|---|
| Agente (`agentActionSchema`) | JSON estricto (unión discriminada) | prompt-only |
| Juez (`Verdict`) | JSON estricto | prompt-only |
| Transcripción (`{text}`) | JSON trivial, payload de audio en base64 | prompt-only, ×3 subidas de audio si falla |
| `testAiCredentials` | texto libre ("ok") | sin JSON (correcto) |

Modelos/proveedores configurables: `OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`,
`OPENROUTER_TRANSCRIBE_MODEL`, `OPENROUTER_BASE_URL` (OpenRouter u otro
OpenAI-compatible), y token+modelo+modelo del juez **por organización**
(`resolveAiConfig`). No todo modelo acepta `response_format`.

Cobertura actual: `ai-adapter.test.ts` **consolida** "3 intentos ante 500" y
"reintenta con STRICT"; los tests de pipeline sólo cubren el camino ok
(`chatJson` mockeado). Nada prueba el handoff `error`, ni `Retry-After`, ni
logs.

## 3. Comportamiento deseado

### 3.1 Petición estructurada (D1–D3)

`chatJson` pide JSON con las capacidades oficiales del proveedor, en escalera:

1. `response_format: {type:"json_schema", json_schema:{name, strict:true, schema}}`
2. `response_format: {type:"json_object"}` (compatibilidad controlada)
3. sin `response_format` (sólo prompt; el comportamiento previo, como último
   recurso explícito)

Con OpenRouter se agrega `provider:{require_parameters:true}` **sólo** en los
niveles 1–2: el proveedor no puede ignorar en silencio el parámetro; si ningún
endpoint del modelo lo soporta, responde 4xx y eso es una señal clara, no una
respuesta de texto plano inesperada.

**Cuándo SÍ se baja de nivel (rev. 2).** Un 400/404/422 no significa "formato
no soportado": puede ser un esquema inválido, un endpoint equivocado, un modelo
inexistente o una regresión nuestra — y bajar de nivel lo escondería. Sólo se
baja ante una señal EXPLÍCITA (`src/lib/ai/rejection.ts`, `classifyRejection`),
en este orden de evidencia:

1. campos estructurados del cuerpo de error (`error.code`, `error.type`,
   `error.param`);
2. la frase fija de OpenRouter para `require_parameters` ("No endpoints found
   that can handle the requested parameters"; su 404 no trae código propio);
3. un mensaje que nombre el formato (`response_format`, `json_schema`,
   `json_object`, "structured output") **y** diga que no se soporta, ambos en
   el mismo texto;
4. nada de lo anterior → `invalid_request`, **sin degradar**.

| Causa | Señal | Código | ¿Baja de nivel? |
|---|---|---|---|
| Formato realmente no soportado | `param: response_format*`, `code: unsupported_response_format`, frase de `require_parameters`, o mensaje formato+"no soportado" | `unsupported_response_format` | **Sí** (sólo en `auto`) |
| Esquema rechazado | `code`/`type` `invalid_json_schema`, o mensaje "Invalid schema…" (aunque nombre `response_format`) | `schema_rejected` | No (bug del conversor) |
| Modelo inexistente | `code: model_not_found`, "is not a valid model ID", "No endpoints found for …" | `model_not_found` | No |
| Petición inválida / genérico | cualquier otro 400/404/422, cuerpo vacío o no JSON | `invalid_request` | No |

El texto del error se compara contra esas frases y se descarta: no se guarda ni
se registra (puede citar la petición). Con `AI_RESPONSE_FORMAT` fijo no hay
escalera: rechazo explícito → `unsupported_response_format`.

**Selección explícita y observable**: `AI_RESPONSE_FORMAT` =
`auto` (default) | `json_schema` | `json_object` | `off`.
- `auto`: empieza en el nivel más alto **recordado para ese (host, modelo)**
  (memoria en proceso, TTL 6 h); ante un 4xx (400/404/422) en modo estructurado baja UN
  nivel por vez (máx. 2 bajadas por llamada), recuerda el nivel que funcionó y
  emite un log `warn` operativo (`fallback json_schema→json_object`).
- valor fijo: **sin** escalera; si el modelo no lo soporta el resultado es
  `unsupported_response_format` (config permanente, visible, sin bucles).
- Si dos niveles seguidos fallan con el **mismo** 4xx y el nivel `none` también
  falla, no era el formato: se reporta el error real (`provider_error`
  no reintentable / `unauthorized`), no `unsupported_response_format`.

**Esquema JSON derivado de Zod** (D2): el JSON Schema se genera a partir del
esquema Zod que ya existe (`agentActionSchema`, `Verdict`, transcripción) con un
conversor propio de subconjunto (`src/lib/ai/json-schema.ts`). Un tipo Zod fuera
del subconjunto **lanza** (no se ignora), y un test recorre todos los esquemas
reales para que un cambio futuro que rompa el conversor falle en CI y no en
producción. Zod sigue siendo la última frontera: la salida SIEMPRE se re-valida.

**Modo estricto y unión discriminada**: los proveedores estrictos exigen raíz
`object`, todas las propiedades `required` y `additionalProperties:false`. La
unión de acciones se aplana a un "sobre" (`action` enum + los campos de cada
variante como `anyOf[T,null]`). El servidor **elimina los `null`** antes de
validar con el Zod real, así que la semántica por variante (campos obligatorios
de `book_slot`, etc.) sigue siendo la de siempre. Las restricciones `min/max`
no viajan en el esquema estricto (no todos los proveedores las aceptan); las
aplica Zod.

Por consumidor:
- **Agente**: estructurado (auto). Corrección de `invalid_json` desactivada en
  el adaptador: la maneja la recuperación de texto plano (3.4).
- **Juez**: estructurado (auto) + una corrección compacta.
- **Transcripción**: estructurado (auto), **sin** corrección ni reintento por
  formato: reenviar el audio (base64) por un error de presentación es el peor
  caso de costo; si el modelo no obedece, degrada a "sin transcripción" (como
  hoy) en UNA llamada.
- **`testAiCredentials`**: sin `response_format` (pide sólo "ok").

### 3.2 Clasificación de errores (D4)

Código explícito en el resultado, nunca por texto del mensaje:

| Código | Origen | Clase |
|---|---|---|
| `not_configured` | sin token/modelo | config |
| `unauthorized` | HTTP 401/403 | config |
| `unsupported_response_format` | rechazo **explícito** del formato (ver 3.1) con `AI_RESPONSE_FORMAT` fijo, o agotado el presupuesto en plena bajada | config |
| `schema_rejected` | el proveedor rechazó nuestro JSON Schema | config |
| `model_not_found` | modelo inexistente / sin endpoints | config |
| `invalid_request` | 400/404/422 sin causa identificable | config |
| `rate_limited` | HTTP 429 | transporte |
| `timeout` | abort por `timeoutMs` | transporte |
| `network_error` | `fetch` rechazó (DNS, reset…) | transporte |
| `provider_error` | 5xx, 402, `error` en cuerpo 200, sin contenido | transporte |
| `invalid_json` | hubo texto pero no un objeto JSON extraíble | formato |
| `invalid_schema` | JSON objeto que no cumple Zod | formato |

`errorClass(code)` → `"config" | "transport" | "format"` vive en
`src/lib/ai/errors.ts` (módulo aparte para que los tests que mockean `@/lib/ai`
no se rompan). El resultado de error lleva `status?`, `retryAfterMs?` y
`draft?` (texto del modelo, **sólo en memoria** para la recuperación; nunca
va a `detail` ni a logs).

### 3.3 Política de reintentos y presupuesto de llamadas (D5)

**Invariantes (rev. 2)** — comprobados por
`tests/unit/pipeline-format-failure.test.ts` sobre las 512 secuencias posibles
de 3 respuestas (8 tipos), contando TODAS las llamadas que llegan al proveedor:

- **I1** Un turno del agente hace **≤ 3 llamadas** al proveedor, sea cual sea la
  combinación de reintentos, bajadas de formato, corrección y recuperación.
- **I2** Si el problema es **sólo de formato o validación** (texto plano, JSON
  inválido, esquema inválido): **≤ 2 llamadas** (principal + UNA corrección **o**
  UNA recuperación), sin handoff.
- **I3** Reintentos de transporte, escalera de `response_format`, corrección y
  recuperación comparten **el mismo presupuesto** (`CallBudget`,
  `src/lib/ai/budget.ts`): lo decrementa `chatJson` antes de cada llamada y lo
  recibe también `recoverPlainText`.
- **I4** Nunca 3 reintentos de 429/5xx más una llamada de recuperación: con 1
  llamada inicial + 2 reintentos el presupuesto está agotado y no se abre la
  recuperación.
- **I5** Al agotarse: sin más llamadas ni esperas; termina con el último error
  real y la degradación de su clase (§3.5). Ante un error determinista nunca se
  repite una llamada idéntica.

Los sub-límites por clase siguen vigentes, pero el presupuesto manda:

| Situación | Política |
|---|---|
| 429 | hasta 2 reintentos; espera `Retry-After` (si > 20 s no se espera: `rate_limited` con `retryAfterMs`); sin header: 1 s, 2 s |
| 5xx / `network_error` / cuerpo vacío | hasta 2 reintentos, backoff 500 ms · 2ⁿ |
| `timeout` | 1 reintento |
| `invalid_json` | ≤ 1 corrección **compacta** (borrador → esquema, sin historial) — o 0 si el consumidor la desactiva (agente: la maneja la recuperación) |
| `invalid_schema` | ≤ 1 corrección **con contexto** (mensajes originales + salida previa + rutas inválidas, sin valores) |
| Corrección total | ≤ 1 por invocación (formato o esquema, no ambas) |
| Rechazo explícito de formato en `auto` | bajar un nivel (cambia la petición; cuenta contra el presupuesto) |
| 401/403, 402, `schema_rejected`, `model_not_found`, `invalid_request` | 0 reintentos |

Consumidores: el agente y la recuperación comparten UN presupuesto de 3 por
turno; el juez usa el suyo (3, una llamada por conversación); la transcripción
usa 2 (cada llamada sube el audio en base64).

### 3.4 Recuperación de texto plano (D6)

Sólo el agente. Ante `invalid_json` con `draft` no vacío, `recoverPlainText`
(`src/server/ai/recovery.ts`) aplica **capas independientes**; cualquiera que
falle degrada (3.6):

1. **Filtro determinista** sobre el borrador: no vacío, ≤ 700 caracteres, sin
   bloques de código, sin JSON/`"action"`, sin etiquetas tipo herramienta/XML
   (`<tool…>`, `<system>`, `[INST]`, `<|…|>`), sin trazas de error, sin
   identificadores internos (`ct_…`, `cv_…`, `msg_…`, `sk-or-…`, `Bearer`), y
   **sin solapamiento de ≥ 8 palabras consecutivas con el bloque de reglas del
   prompt del sistema** (fuga del prompt). El KB **no** se compara: citarlo es
   responder.
2. **Una llamada compacta** (sin KB, sin historial; borrador delimitado y
   declarado DATO) con esquema restringido a `reply | none`. Debe devolver
   `reply` con el texto **sin modificarlo**, o `none` si el borrador afirma
   haber ejecutado algo (agendar, mover, guardar, escalar), contiene
   instrucciones internas/datos internos o no es un mensaje para el cliente.
3. **Verificación posterior**: el `text` devuelto debe ser el borrador
   (normalizando espacios) o estar contenido en él; se envía **el borrador
   verificado**, jamás texto nuevo del modelo.

La recuperación sólo se abre si el borrador es la respuesta **original** del
modelo (`meta.corrected === false`): si ya hubo una corrección por esquema y
ésta devolvió prosa, no se encadena otra llamada (tope: 1 principal + 1
corrección **o** 1 principal + 1 recuperación, nunca ambas).

Nunca se ejecuta `book_slot`, `offer_slots`, `request_reschedule`, `move_stage`,
`update_lead` ni `handoff` desde texto plano: el esquema de recuperación **no
contiene** esas acciones. El resultado se entrega como `reply` normal
(`aiGenerated`), y queda registrado `recovered=plain_text`.

Un JSON válido pero inválido para Zod (`invalid_schema`) **no** se convierte en
`reply` (un `book_slot` incompleto con `reply:"Te confirmo tu cita"` sería una
promesa falsa): recibe la corrección con contexto de 3.3; si falla, degrada.
Una acción que sí valida pero no pasa las validaciones del servidor
(`degradeAction`, `findOffered`, `resolveStage`) sigue el camino que ya tiene.

Endurecimiento de extracción (`extractJson`): sólo se aceptan **objetos** JSON
(no `42`, no `"ok"`), y un objeto embebido en prosa se acepta sólo si la prosa
alrededor es corta (≤ 200 caracteres): una respuesta larga que *contiene* un
ejemplo `{"action":"handoff"}` es texto, no una orden. Markdown ```` ```json ````
sigue tolerado.

### 3.5 Política de handoff (D7)

| Resultado del turno | Acción |
|---|---|
| Acción válida | como hoy |
| `not_configured` | silencio (como hoy) |
| Config (`unauthorized`, `unsupported_response_format`, `schema_rejected`, `model_not_found`, `invalid_request`) o transporte agotado (`rate_limited`, `timeout`, `network_error`, `provider_error`) | `applyHandoff("error")` (el contrato `ai.md` ya lo define). Sin mensaje al cliente. Cuenta para el circuito (§3.7). Un `unauthorized` además marca la conexión de IA de la organización como `error`. Log `outcome=handoff_error`. |
| **Circuito abierto** (§3.7) | **sin llamada y sin handoff**; IA activa; el cliente recibe (una vez por periodo) el mensaje fijo de degradación |
| Formato (`invalid_json` sin recuperar, `invalid_schema` tras corrección, texto plano rechazado) | **sin handoff**, IA sigue activa: degradación segura 3.6 |
| Formato **dos turnos consecutivos** (`conversation.ai_fail_count ≥ 2`, §3.6) | ya no es aislado: `applyHandoff("error")`, sin promesas al cliente |
| Cliente pide humano / `handoff` del modelo / ventana cerrada / reprogramación / error de acción | sin cambio |

### 3.6 Degradación segura

Un mensaje fijo, breve y sin promesas, configurable por despliegue con
`AI_FALLBACK_MESSAGE` (default: "Disculpa, no pude procesar bien tu mensaje.
¿Podrías escribirlo de nuevo, por favor?"). No promete humano (no hay
handoff), no afirma acciones, no contiene contenido del modelo ni del cliente.
Se envía como respuesta de IA normal (en Laboratorio se persiste en el
sandbox). La conversación queda recuperable: el siguiente mensaje del cliente
dispara un turno normal. Si el envío del fallback falla, se registra y no se
propaga.

**Estado técnico de fallos (rev. 2, migración 0022).** "Consecutivo" ya no se
deduce del texto que vio el cliente. Tres columnas en `conversation`
(`ai_fail_count`, `ai_fail_kind`, `ai_fail_at`; ver `data-model.md`):

- **Alcance: la conversación.** Lo que se decide con el contador es "¿este
  cliente ya recibió una degradación y volvió a fallar?", una decisión sobre su
  hilo. Lo global (organización/modelo) lo cubre el circuito (§3.7); una
  columna por organización/modelo sería el alcance equivocado.
- **Registra**: tipo del último fallo (`ai_fail_kind`, un código de `AiErrorCode`),
  momento (`ai_fail_at`) y número de fallos de formato consecutivos
  (`ai_fail_count`).
- **Incremento atómico en SQL** (`UPDATE … SET ai_fail_count = CASE … count + 1
  … RETURNING`): dos turnos concurrentes — de la misma instancia o de varias —
  obtienen conteos distintos; verificado con 25 fallos concurrentes contra
  Postgres (`scripts/verify-ai-fail-state.ts`).
- **Ventana de 6 h**: un fallo más viejo reinicia la cuenta en 1 (un fallo suelto
  de hace días no es "el turno anterior").
- **Reinicio**: un turno con acción válida, una respuesta de texto plano
  recuperada, reactivar la IA (Bandeja) o el reset del bot lo ponen en 0.
- **Persistente**: sobrevive a reinicios y despliegues (está en la base).
- **Independiente del texto**: cambiar `AI_FALLBACK_MESSAGE`, editar un mensaje
  o que un operador escriba lo mismo no afecta la cuenta.
- Si la base falla al registrar, se degrada (nunca se escala a ciegas) y el error
  se loguea sin mensaje.

### 3.7 Circuito de protección por organización + modelo (D9)

Problema: una configuración global rota (token revocado, modelo inexistente,
formato incompatible, proveedor caído) hacía que cada conversación pagara sus
llamadas fallidas y terminara en su propio handoff `error`. Implementación:
`src/server/ai/circuit.ts`.

- **Distingue** fallo aislado de fallo global. Sólo cuentan fallos de
  **configuración** (`unauthorized`, `model_not_found`, `schema_rejected`,
  `invalid_request`, `unsupported_response_format`) y de **transporte** ya
  agotados. Los de **formato** son por mensaje y nunca cuentan; `not_configured`
  tampoco.
- **Se abre** tras 2 fallos de configuración (3 de transporte: puede ser un
  bache) **sin un éxito en medio**, dentro de 10 min y desde **≥ 2
  conversaciones distintas**. Un fallo aislado de una conversación no lo abre.
  Antes de abrir hay a lo sumo 2 (config) o 3 (transporte) handoffs `error`; con
  el circuito abierto, ninguno.
- **Abierto**: los turnos **no llaman** al proveedor (cero costo) y **no hacen
  handoff**: la IA sigue activa y la conversación es recuperable. El cliente
  recibe **una vez** (por conversación y periodo, dedupe con `ai_fail_kind =
  'circuit_open'`) el mensaje fijo de degradación, que **no promete un humano**
  porque no se creó ningún handoff.
- **Recuperación**: tras 5 min (×2 en cada reapertura, tope 30) pasa a
  semiabierto: UN turno de prueba (los demás siguen bloqueados). Si sale bien,
  cierra; si falla, reabre. Si la prueba nunca reporta, otro puede probar a los
  2 min.
- **Alcance**: clave `organización|modelo` — otra organización u otro modelo (p.
  ej. el del juez) no se ven afectados.
- **Señal operativa** (sin mensajes, teléfonos, tokens ni contenido): logs
  `event=circuit_open org=… model=… code=… failures=… cooldownSec=…`,
  `circuit_blocked` (por turno bloqueado) y `circuit_closed`; un `unauthorized`
  marca `ai_credentials.status = 'error'` (Ajustes → IA ya lo muestra).
- **Estado en memoria del proceso** (monolito por negocio, Constitución II: sin
  colas externas). Con varias réplicas cada una abre el suyo; un reinicio lo
  cierra y se reabre tras los mismos fallos. Es protección de **costo**; la
  corrección (contador por conversación) está en la base.

### 3.8 Modelo efectivo y compatibilidad (rev. 2)

No se asume el modelo de producción. Fuente única: `resolveEffectiveModel`
(`src/lib/ai/config.ts`); no hay modelo por defecto en el código.

| Llamada | Precedencia |
|---|---|
| Agente | modelo de la organización (Ajustes → IA) > `OPENROUTER_MODEL` |
| Juez del Laboratorio | juez de la organización > modelo de la organización > `OPENROUTER_JUDGE_MODEL` > `OPENROUTER_MODEL` |
| Transcripción | `OPENROUTER_TRANSCRIBE_MODEL` > `OPENROUTER_MODEL`. **Sólo entorno**: el token/modelo por organización NO aplica (hallazgo, sin cambiar) |
| Recuperación de texto plano | el mismo del agente |

**Cómo verificar el identificador exacto en producción, sin tokens:**

1. `GET /api/settings/ai` (sesión iniciada) devuelve
   `effective: { agent, judge, transcribe }` con `model` y `source`
   (`organization` | `environment`); nunca una credencial.
2. Cada línea de log `[ia] event=chat_result … model=<id>` lleva el modelo
   realmente usado en esa llamada.
3. El identificador de entorno se ve en las variables del servicio (Coolify) —
   `OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`, `OPENROUTER_TRANSCRIBE_MODEL`.

Compatibilidad: un modelo sin `json_schema` sigue funcionando (`auto` baja a
`json_object` y luego a sólo-prompt) **sólo ante rechazo explícito** del
formato; cualquier otro error se ve como error (§3.1). Un operador puede
fijarlo con `AI_RESPONSE_FORMAT=json_object|off` para no pagar la sonda.

### 3.9 Conversor Zod → JSON Schema: contrato y auditoría

`src/lib/ai/json-schema.ts` es un **subconjunto deliberado**:

| Construcción Zod (v3) | Tratamiento |
|---|---|
| `object` | `type:object`, `additionalProperties:false`, `required` = TODAS las propiedades |
| `string`, `boolean`, `number`/`int` | `type` correspondiente |
| límites (`min`, `max`, `trim`, `email`…) | **no viajan** (no todo proveedor los acepta en estricto); los aplica Zod al validar |
| `literal` (string/number/boolean), `enum` | `enum` con su `type` |
| `array` | `type:array` + `items` |
| `optional` en un objeto | `anyOf[T, null]` (aplanado si `T` ya es `anyOf`); el servidor quita los `null` (`stripNulls`) antes de validar con el Zod real |
| `discriminatedUnion` **raíz** | se aplana a un sobre: `action` = enum de todos los literales + la unión de los campos de las variantes, todos `anyOf[T,null]`; qué exige cada variante lo sigue decidiendo Zod |
| `discriminatedUnion` anidada | `anyOf` de objetos estrictos |
| refinamientos (`refine`) | se desenvuelven (no cambian la forma) |
| `transform`, `union`, `record`, `tuple`, `nullable`, `default`, `date`, cualquier otro | **rechazado**: lanza `UnsupportedSchemaError` |

Ante un esquema futuro desconocido el conversor **lanza**; `chatJson` lo
degrada a `json_object` con un `warn` (nunca rompe una conversación), pero el
CI lo detecta antes:

- `src/server/ai/schemas.ts` registra TODOS los esquemas enviados al proveedor
  por `schemaName` (`accion_agente` con y sin agenda, `veredicto_juez`,
  `transcripcion`, `recuperacion_texto`).
- `tests/unit/ai-provider-schemas-contract.test.ts` recorre el registro
  (el conversor no lanza; cada nodo cumple el dialecto estricto: sin
  `minLength/pattern/format/oneOf/$ref/default`, `required` completo,
  `additionalProperties:false`, `anyOf` plano) y **escanea `src/`**: un
  `schemaName` sin registrar, una entrada huérfana, o un archivo nuevo que
  llame a `chatJson` sin declararse rompen la prueba.

### 3.10 Prueba real controlada contra OpenRouter (preparada, NO ejecutada)

`tests/live/ai-real.live.test.ts` (`pnpm test:ai-live`, fuera de `pnpm test`).

**Alcance y tope de gasto.** 2 llamadas facturables, prompt mínimo (no el del
negocio): ≈ 4 650 caracteres por llamada (prompt 3 946 + esquema 615 + mensaje)
→ **≤ 1 600 tokens de entrada** cada una (a ≥ 3 caracteres/token), y
`maxTokens: 400` (opt-in de `chatJson`, `max_tokens`) → **≤ 400 de salida** cada
una. Total **≤ 3 200 de entrada + ≤ 800 de salida**. Costo máximo =
3 200·P_in + 800·P_out: ≈ **US$ 0.02** con precios clase Sonnet (3/15 por M) y
≤ **US$ 0.11** con precios de gama alta (15/75 por M). Contrastar con la tarifa
del modelo en su página de OpenRouter. Con un modelo de razonamiento,
`max_tokens` incluye los tokens de razonamiento: puede truncar y fallar como
`invalid_json` (rechazo barato, no gasto adicional).

**Variables requeridas** (todas en `.env.live`, gitignored, salvo la de
confirmación): `OPENROUTER_API_TOKEN` (una key propia con saldo mínimo; el token
de la organización no se puede leer de vuelta), `AI_LIVE_MODEL` (id **exacto**;
explícito a propósito: jamás se hereda `OPENROUTER_MODEL` del `.env` de
desarrollo, que apunta al mock), `OPENROUTER_BASE_URL=https://openrouter.ai/api`,
`AI_RESPONSE_FORMAT` (opcional, el de producción; default `auto`), y
`AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO` (a mano, justo antes de correr).

**Triple candado** — sin los tres no se hace ninguna llamada (verificado: se
omite y lo dice); además se niega si la base URL no es OpenRouter.

**Comando exacto** (raíz del repo):

- bash: `AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO pnpm test:ai-live`
- PowerShell: `$env:AI_LIVE_CONFIRM="SI_CONSUMIR_SALDO"; pnpm test:ai-live`

**Aprobación** = los 3 tests en verde, con estas dos líneas (nunca la key):
`[ai-live] modelo=<id> llamadas=1 modo=json_schema fellBack=false ok=true accion=<...>` y
`[ai-live] modelo=<id> llamadas=1 modo=json_schema ok=true accion=reply`, más
`Tests 3 passed`. Demuestra: (1) una respuesta estructurada normal = 1 llamada;
(2) el modelo acepta el modo configurado sin bajar de nivel; (3) la pregunta
fuera de alcance vuelve como `reply` (no `handoff`, sin efectos); (4) ni el
prospecto, ni la respuesta, ni la key en los logs, y sí `traceId`, `model`,
`route=openrouter.ai`, `durationMs`, `outcome=ok`.

**Rechazo** = cualquier test rojo. Lectura: `llamadas>1` -> algo reintentó (ver
el `code`); `modo != json_schema` o `fellBack=true` -> el modelo/proveedor no
acepta `json_schema` estricto: decidir `AI_RESPONSE_FORMAT=json_object` o cambiar
de modelo; `ok=false` con `unauthorized` (key), `model_not_found` (id mal
escrito), `unsupported_response_format` / `schema_rejected` / `invalid_request`
(compatibilidad o regresión, **bloquea el despliegue**); `accion != reply` en la
pregunta fuera de alcance -> regresión de comportamiento; fallo del test de
logs -> regresión de privacidad (**bloquea el despliegue**).

Procedimiento: (1) leer el modelo exacto de producción en
`GET /api/settings/ai -> effective.agent.model` (con la sesión del dueño; p. ej.
abrir esa URL en el navegador ya autenticado; sólo `effective`, jamás
`tokenLast4`); (2) crear `.env.live`; (3) ejecutar el comando de arriba.

### 3.11 Observabilidad sin datos sensibles (D8)

`src/lib/ai/log.ts` define eventos con **campos permitidos** (tipados, sin
`string` libre para contenido): `event`, `traceId` (id de conversación),
`model`, `route` (host del proveedor y, si lo informa, el proveedor servido),
`attempt`, `mode` (json_schema|json_object|none), `fallback` (bool),
`durationMs`, `status`, `code`, `outcome`, `recovered`, y (circuito) `org`
(id interno), `failures`, `cooldownSec`. Nunca: `raw`,
`draft`, prompts, mensajes, teléfonos, tokens, notas de voz, cuerpos de error
del proveedor. `detail` de los resultados de error es un texto **fijo** por
código (más el status HTTP). Los `console.error` del pipeline con `${err}` se
reemplazan por `describeError(err)` (nombre + código, sin mensaje: los errores
de BD y de Meta pueden traer parámetros con teléfono o texto). **No se añade
modo de depuración con contenido**: superficie que no hace falta; si se
necesita, se reproduce con el mock.

## 4. Casos de uso y casos límite

- CU1 Respuesta JSON válida → 1 llamada, sin más.
- CU2 JSON en markdown → tolerado.
- CU3 Incidente: fuera de alcance → texto plano → filtro → 1 llamada compacta →
  `reply` verificado → total 2 llamadas, sin handoff, sin acciones.
- CU4 Modelo sin soporte de `json_schema` → baja a `json_object` (log), se
  recuerda; siguiente turno ya empieza ahí.
- CU5 Modelo sin soporte alguno → nivel `none`; el agente funciona como antes
  pero con recuperación y sin 3 cargos.
- CU6 429 con `Retry-After: 2` → espera 2 s, reintenta una vez.
- Límite: borrador vacío/enorme/con código/con etiquetas → degradación sin
  llamada extra. Borrador que es una **frase con `{`** → no es objeto JSON.
  `null` en campos estrictos → se eliminan. Acción con `null` explícito en un
  campo requerido → `invalid_schema`. Respuesta HTTP 200 con `error` en el
  cuerpo (OpenRouter) → se clasifica por su `code`. Turno de Laboratorio con
  degradación → mensaje en sandbox, nunca API real. Dos ráfagas simultáneas:
  el lock del coalesce ya serializa turnos por conversación.
- Límite: contenido de `finish_reason:"length"` (JSON truncado) → `invalid_json`
  → una corrección; si persiste, degrada (riesgo residual documentado).

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| El conversor JSON Schema diverge de Zod | Lanza ante tipos no soportados + test sobre todos los esquemas reales + Zod re-valida siempre |
| Modelos que en estricto rellenan opcionales con `""` en vez de `null` (p. ej. `reason:""` en `book_slot`) | Cae en `invalid_schema` → una corrección con contexto → si no, degrada; nunca ejecuta |
| La llamada de recuperación es manipulable por el borrador | Borrador delimitado y declarado DATO; esquema sin acciones con efectos; verificación posterior de contención; el texto enviado es el borrador, no la salida del modelo |
| `require_parameters` reduce el pool de proveedores → más 4xx | Escalera `auto` con memoria por modelo; valor fijo para quien quiera control |
| Texto plano "seguro" pero con una promesa falsa | Capa 2 la clasifica (`none`); filtro y verificación no bastan por sí solos — por eso hay capas |
| El mensaje de degradación se repite | Segundo consecutivo → handoff `error` |
| Un 400/404/422 ajeno al formato baja el nivel y queda recordado | **Resuelto en rev. 2**: sólo una señal explícita baja (§3.1); lo demás es error visible |
| Un proveedor OpenAI-compatible que rechaza el formato con un texto que no reconocemos | No se degrada: sale como `invalid_request` visible y el operador fija `AI_RESPONSE_FORMAT=json_object\|off`. Es el costo de la regla conservadora |
| Circuito por proceso: réplicas y reinicios | Cada réplica abre el suyo; la corrección vive en la base. Sólo afecta al costo |
| El circuito bloquea a una organización por un fallo real transitorio | Semiabierto tras 5 min (turno de prueba); logs `circuit_*` para el operador |
| La migración 0022 en producción | Aditiva (`ADD COLUMN IF NOT EXISTS`, default 0, sin backfill ni reescritura de tabla); se aplica al arrancar el contenedor |

## 6. Decisiones (resumen)

- **D1** `json_schema` estricto preferido, `json_object` de compatibilidad, `none` como último recurso, todo explícito y observable.
- **D2** Conversor propio de subconjunto en vez de `zod-to-json-schema`: cero dependencias nuevas (Constitución II, superficie de Dependabot), salida hecha a la medida del modo estricto (sobre aplanado, nullables), y falla ruidosamente fuera del subconjunto. Alternativa descartada: JSON Schema escrito a mano (se desincroniza). Zod 4 nativo (`z.toJSONSchema`) requiere migrar el repo: fuera de alcance.
- **D3** Transcripción sin corrección; juez con una; credenciales sin `response_format`.
- **D4** Códigos de error explícitos, tres clases.
- **D5** Reintentos por clase y presupuesto **compartido por turno de 3 llamadas** (rev. 2; antes 5 por capa, peor caso medido 6).
- **D6** Recuperación en capas; texto plano nunca produce acciones con efectos.
- **D7** Formato ≠ error del proveedor: sin handoff en el primer fallo; handoff en el segundo consecutivo o ante fallo técnico persistente.
- **D8** Logs por lista blanca de campos; sin modo de depuración con contenido.
- **D9** (rev. 2) Estado de fallos por conversación en la base (columnas, no tabla nueva: es un atributo de la conversación y se lee con la fila que el turno ya carga); circuito por organización+modelo en memoria (protección de costo, no de corrección).
- **D10** (rev. 2) Bajar de formato sólo ante señal explícita; fallback conservador `invalid_request`.

## 7. Criterios de aceptación verificables

- **AC1** La petición estructurada incluye `response_format` (json_schema por defecto); `AI_RESPONSE_FORMAT` la cambia; `testAiCredentials` sigue enviando sólo `{model,messages}`.
- **AC2** JSON válido → exactamente 1 llamada.
- **AC3** Un turno hace ≤ 3 llamadas para TODA combinación (512 secuencias medidas); sólo formato ≤ 2; texto plano nunca produce 3.
- **AC4** El incidente (texto plano fuera de alcance) termina en `reply` entregado, 2 llamadas, cero `applyHandoff`, cero acciones con efectos.
- **AC5** Un 429 espera `Retry-After`; 5xx reintenta ≤ 2; timeout ≤ 1; 4xx determinista 0 reintentos.
- **AC6** `invalid_json`/`invalid_schema` → ≤ 1 llamada correctiva.
- **AC7** Acción desconocida, `book_slot` incompleto y `move_stage` inválido no ejecutan nada ni cambian el pipeline.
- **AC8** Formato fallido aislado → sin handoff, mensaje de degradación, IA activa; segundo consecutivo → handoff `error`; fallo persistente del proveedor → handoff `error`.
- **AC9** Rechazo **explícito** de formato en `auto` → baja con log y memoria; 400/404/422 genérico, esquema rechazado y modelo inexistente → error visible sin bajar; valor fijo → `unsupported_response_format` sin bucle.
- **AC13** El contador de fallos consecutivos vive en la base, es atómico (25 concurrentes → 1..25), respeta la ventana, se reinicia con un éxito, y no depende del texto visible.
- **AC14** Con el circuito abierto: 0 llamadas, 0 handoffs, aviso único por conversación, señal `circuit_open` sin contenido; cierra con un turno de prueba exitoso.
- **AC15** `GET /api/settings/ai` expone el modelo efectivo y su fuente sin credenciales.
- **AC16** Toda llamada a `chatJson` usa un `schemaName` registrado y todo esquema registrado se convierte (prueba de contrato).
- **AC10** Ningún log ni `detail` contiene el texto del cliente, del modelo, prompts ni tokens (test que captura `console.*`).
- **AC11** Juez y transcripción siguen funcionando (unit + mock).
- **AC12** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` en verde; self-test E2E extendido (texto plano, formato inválido, contador que se reinicia, diagnóstico del modelo).

## 8. Plan de pruebas

Unitarias: `ai-adapter.test.ts` (reescrito: petición, escalera, reintentos,
`Retry-After`, timeout, clasificación, extracción endurecida, corrección ≤ 1,
sin `raw` en `detail`), `ai-json-schema.test.ts` (conversor sobre esquemas
reales + `Verdict` + transcripción), `agent-plain-text-recovery.test.ts`
(filtro, capas, verificación, sin acciones), `pipeline-format-failure.test.ts`
(incidente end-to-end sobre el pipeline real con `chatJson` mockeado, y otro
con `fetch` mockeado: 2 llamadas; formato sin handoff; consecutivo → handoff;
transporte → handoff; `book_slot` incompleto / acción desconocida /
`move_stage` inválido; logs sin contenido), ajustes a `judge.test.ts` y
`media-transcribe.test.ts`. E2E: `ai-mock` gana disparadores deterministas
(`prueba:texto-plano`, `prueba:formato-invalido`) y `scripts/e2e-selftest.mjs`
+ `tests/e2e/us-ai-formato.md` cubren el incidente con la app viva.

Rev. 2: `ai-rejection.test.ts` (clasificación de 400/404/422: formato, esquema,
modelo, petición, genérico), `ai-circuit.test.ts`, `failure-state.test.ts`,
`ai-effective-model.test.ts`, `ai-provider-schemas-contract.test.ts`, y en
`pipeline-format-failure.test.ts` la matriz de presupuesto, el circuito sobre el
pipeline real y el contador técnico. Contra Postgres real:
`scripts/verify-ai-fail-state.ts`. Prueba real: `tests/live/` (no ejecutada).

## 9. Fuera de alcance (decidido NO hacer)

Segundo proveedor de IA; streaming; cambiar reglas comerciales o la
personalidad de Max; columna nueva de configuración por organización para el
mensaje de degradación; cablear
normalizar `""` → `undefined` en opcionales (requiere normalizador consciente
del esquema); circuito compartido entre réplicas (requeriría estado externo);
que la transcripción use el token/modelo por organización (hallazgo aparte).
