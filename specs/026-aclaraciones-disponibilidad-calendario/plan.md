# 026 — Plan de implementación

Spec: [`spec.md`](spec.md) · Datos: [`data-model.md`](data-model.md) · Tareas: [`tasks.md`](tasks.md)

**Nada de esto está implementado.** Este plan describe CÓMO se haría cuando el dueño lo pida; no se ha
tocado código de producto.

## Arquitectura

```
ANTES (025)                                       DESPUÉS (026)
«jueves de la próxima semana»                     «jueves de la próxima semana»
      │                                                 │
      ▼                                                 ▼
normalizeExpression trata "este"/"proximo"        parseWeekQualifier separa el calificador
como relleno genérico; "de/que/viene/semana"      de semana ANTES de normalizar:
no se quitan ⇒ no matchea nada ⇒ clarify()          - ninguno/"próximo"/"que viene" → ruta A (existente)
                                                     - "este/esta"                  → ruta B (nueva)
turno 2: «el jueves» (solo)                         - "de la [próxima] semana..."  → ruta C (nueva)
      │                                                 │
      ▼                                                 ▼
sin memoria: vuelve a resolver "jueves" bare      agendaClarifyContext.weekModifier="next" (guardado
(ocurrencia más cercana) — pierde "próxima          en conversation tras el turno 1) se FUSIONA con
semana" del turno 1                                 el `day` del turno 2 antes de resolver → ruta C

aclaración: 1 de 3 textos fijos, sin contador     clarify() devuelve {text, reason}; el servidor
                                                   incrementa conversation.agenda_clarify_count,
                                                   varía el texto por razón, y en el 2.º intento
                                                   consecutivo ofrece 2 fechas concretas; al 3.º,
                                                   handoff (handoff_reason:"agenda_ambigua")
```

## Piezas

| Pieza | Archivo | Cambio |
|---|---|---|
| Calificador de semana | `src/lib/time/day-expressions.ts` | Nueva función pura `parseWeekQualifier(raw)` → `{qualifier: "none"\|"same"\|"next", rest: string}`; saca `este`/`esta` de la lista de relleno genérico; `resolveDayExpression` se ramifica en 3 rutas (§3.1 de la spec); `DayResolution` gana `reason?: "already_passed_this_week"` |
| Días alternativos | `src/server/agenda/availability-query.ts` | `AvailabilityQuery.days?: string[]`; nuevo `AvailabilityKind:"days"`; `answerQuery` evalúa cada día por separado (reglas 12-13), agrega metadatos sobre los días dentro de horizonte |
| Memoria de aclaración | `src/server/agenda/agenda-clarify-context.ts` (nuevo, puro) | `mergeClarifyContext(context, queryDeThisTurn)`, `nextClarifyState(prevState, reason)`: puras, sin BD — las prueba `plan.md` como funciones aisladas |
| Persistencia | `src/lib/db/schema.ts` + migración nueva | 3 columnas en `conversation` (data-model.md); helper `updateAgendaClarifyState(conversationId, state)` con el mismo patrón atómico que `clearFailureState`/`recordFailure` de `failure-state.ts` (023) |
| Fechas candidatas | `src/server/agenda/availability-query.ts` (o módulo nuevo) | `candidateDates(dayExpression, weekQualifier, todayIso, n=2)`: pura, calendario — usada en el 2.º intento consecutivo (regla 14) |
| Pipeline | `src/server/ai/pipeline.ts` | Antes de `checkAvailability`: cargar `agenda_clarify_*` de la conversación, fusionar contexto; después: si `turn.availability.kind==="clarify"`, actualizar el contador/razón/contexto o disparar handoff si llega a 3; si la acción del modelo NO es de agenda, resetear el contador (regla 11-b) |
| Handoff | `src/server/agenda/...` o donde viva `applyHandoff` | Nuevo motivo `"agenda_ambigua"` (TS-only, sin migración) |
| Prompt | `src/server/ai/prompts.ts` | Sin cambios de fondo (el modelo sigue pasando palabras tal cual); documentar en el comentario que el servidor ahora recuerda entre turnos, para que quien edite el prompt no intente "arreglarlo" ahí |
| Cerebro externo | `src/app/api/bot/availability/route.ts` | Acepta `days`; expone `kind:"days"` |

## Fronteras que se respetan

- `computeAvailability` **no se toca** (015).
- `offer_state`, el outbox y `registerAlternatives` (024 §5.6-5.7) **no cambian**.
- La acción `check_availability` sigue sin `reply`: el modelo no redacta horarios ni fechas (D1 de 025,
  sin cambio).
- `ai_fail_count`/`ai_fail_kind`/`ai_fail_at` (023) **no se tocan**; son columnas y mecanismos
  independientes, aunque compartan el patrón de diseño.

## Orden propuesto

1. Funciones puras: `parseWeekQualifier`, las 3 rutas de `resolveDayExpression`, `candidateDates`,
   `mergeClarifyContext`/`nextClarifyState` — con pruebas unitarias exhaustivas (incluida la matriz de
   zona horaria de AC-12) ANTES de tocar BD o pipeline.
2. Migración + schema (`conversation`) + helper de persistencia atómica.
3. `AvailabilityQuery.days`/`AvailabilityKind:"days"` en `availability-query.ts`, con pruebas.
4. Acción `check_availability` (esquema, contrato) + `agent.ts`.
5. Pipeline: carga/fusión de contexto, actualización del contador, handoff al 3.º intento.
6. `GET /api/bot/availability`: `days`.
7. Integración (Postgres real) + mutaciones (igual que 025 §10: cada guarantee con su prueba que la
   rompe a propósito).
8. E2E: extender `tests/e2e/us-disponibilidad.md` con los 7 mensajes de la evidencia real como guion
   de regresión explícito.
9. Prueba real opcional (`pnpm test:ai-live-025`-like) sólo si el dueño la autoriza y hay saldo —
   mismo candado que 025 §11.1; no se ejecuta en este plan.

## Verificación (cuando se implemente)

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:integration
```

Más el E2E completo (`pnpm test:e2e`) y las mutaciones de cada guarantee (§10 de la spec 025 es el
modelo a seguir: forzar cada regla apagada debe romper una prueba). Ninguna de estas compuertas se ha
corrido para 026 — no hay código todavía.
