# 025 — Plan de implementación

Spec: [`spec.md`](spec.md) · Datos: [`data-model.md`](data-model.md) · Tareas: [`tasks.md`](tasks.md)

## Arquitectura

```
ANTES                                        DESPUÉS
prospecto: «¿lunes a las 4?»                 prospecto: «¿lunes a las 4?»
      │                                            │
      ▼                                            ▼
LLM sólo puede pedir offer_slots             LLM: check_availability{day:"lunes",times:["4 de la tarde"]}
(sin parámetros) → repite 09:00…             (sin reply: no redacta ni afirma nada)
   o INFIERE «no hay» de la muestra                │
      │                                            ▼
      ▼                                      queryAvailability  ── UNA consulta al motor real ──▶ computeAvailability
catálogo: 12 de 97 libres (3 por día),             │   (horario, tz, duración, buffer, aviso, citas)
sin metadatos                                      ▼
                                             answerQuery (PURO): resuelve día/hora, evalúa, redacta,
                                             y declara exhaustive / hasMore / scopeComplete / total
                                                   │
                                                   ▼  AgendaTurn { text, offers(shown), availability }
                                             pipeline → sendText({ offers })      ← 024 §5.6, sin código nuevo
                                                   │  tx: message(queued, offer_state=pending) + offered_slot(pending)
                                                   ▼
                                             Meta acepta → activateOffers      (falla → retrying / stale / manual guard)
```

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Interpretación de día y hora | `src/lib/time/day-expressions.ts` | **pura**: «mañana», «lunes», «25 de septiembre», «4 de la tarde», «4 y media»; árbitro = horario del día |
| Consulta | `src/server/agenda/availability-query.ts` | `queryAvailability` (1 llamada al motor) + `answerQuery` **pura** + `claimsNoAvailability` |
| Alternativas cercanas | `src/server/agenda/alternatives.ts` | `nearestSlots`: mismo día primero; usado por `refreshOffer` (R-1 intacto) |
| Acción | `src/server/ai/actions.ts` | `check_availability` (sin `reply`); `degradeAction` → `none` |
| Agente | `src/server/agenda/agent.ts` | `checkAvailability`; `availability` en `AgendaTurn` (también en `offerSlots`/`bookSlot`) |
| Pipeline | `src/server/ai/pipeline.ts` | ejecuta la acción por la vía de 024; **guard** de negaciones escritas por el modelo; **compuerta** de acciones de agenda (`normalize` de `chatJson` + `guardAgendaAction` con el texto del cliente) |
| Prompt | `src/server/ai/prompts.ts` | herramienta + reglas (muestra ≠ agenda; nunca «no hay») |
| Cerebro externo | `src/app/api/bot/availability/route.ts` | defaults corregidos; `diasConAgenda` completo; metadatos; `day`/`from`/`to` |
| Mock de IA | `src/server/dev/ai-mock.ts` | dispara la acción en el self-test |
| Frontera modelo ↔ cliente (rev. correctiva) | `src/server/agenda/query-intent.ts` | **pura**: `normalizeQueryFields` (`""`/`[]` = ausencia), `explicitEdge`, `extractTemporalQuery`, `guardAgendaAction` |
| Cláusula de prioridad (rev. correctiva) | `src/server/ai/prompts.ts` | `AGENDA_PRIORITY_CLAUSE` tras las instrucciones del negocio; reglas duras de `check_availability`/`offer_slots`/`edge` |

## Fronteras que se respetan

- `computeAvailability` **no se toca**: es la fuente única de verdad (015).
- `server/outbox/` **no cambia** (024 G4): la consulta ocurre antes de encolar.
- `registerAlternatives` (024 §5.7) **no cambia**; sólo cambia qué alternativas se calculan.
- `offer_slots` conserva su texto (lo fijan las pruebas de 024).

## Orden

1. Diagnóstico con motor real (rojo antes de corregir) — hecho.
2. Esta spec (antes del código).
3. Funciones puras + pruebas unitarias.
4. Consulta, acción, agente, pipeline, prompt, API.
5. Integración (Postgres real) + E2E + mutaciones.
6. Compuertas.

## Revisión correctiva (tras la corrida real 2)

La prueba real con el perfil de **producción** (`z-ai/glm-5.3-flash`, instrucciones de 7 982 caracteres con la regla
«Usa offer_slots») **falló 3 pruebas** (spec §11.1): `edge:"earliest"` indebido (caso 1), `from:""`/`to:""` (caso 2) y
`offer_slots` ante «la semana que viene» (caso 5). La corrida 1, con el perfil semilla, no lo había expuesto.

```
respuesta cruda del modelo
   │  chatJson({ normalize: normalizeAgentAction })   ← "" / [] / null ⇒ ausencia, ANTES de validar el esquema
   ▼
acción validada (Zod)
   │  guardAgendaAction(acción, texto del CLIENTE desde la última respuesta)
   │     · check_availability: `edge` sólo si el cliente lo pidió (explicitEdge); si no, se quita
   │     · offer_slots + día/fecha/hora/rango/expresión temporal ⇒ check_availability con SUS palabras
   │     · offer_slots genérico y book_slot: intactos
   ▼
agente → queryAvailability (1 llamada al motor) → answerQuery: resuelve, o `clarify` si no entiende («la semana que viene»)
```

Decisiones: (1) se corrige en el **servidor** además del prompt: el prompt empuja, la compuerta garantiza lo visible;
(2) los textos comparados son los del **cliente**, jamás los del modelo; (3) un falso positivo de detección sólo
consulta/aclara, nunca afirma; (4) el perfil del negocio no se edita ni se sanea (la cláusula de prioridad se
antepone al contrato, no reescribe nada); (5) `offer_slots` conserva su texto y `book_slot` nunca se reencamina.

**Prueba real repetida (corrida 3): 5/5** con el mismo modelo y el perfil de producción (spec §11.1). Pendiente sólo el cierre operativo (commit / PR / despliegue).

## Verificación

`pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build` y el E2E
completo desde arranque limpio (`pnpm test:e2e`), más las mutaciones de la §10 de la spec. Las cifras reales y lo
que falta (la repetición con el modelo real) están en la §10 y §11.4 de la spec.
