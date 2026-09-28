# 023 — Tareas

Todas hechas y verificadas salvo T-R7 (a la espera de autorización explícita
para consumir saldo).

## Rev. 1 (formato y texto plano)

- [X] T1 `response_format` (escalera `json_schema` → `json_object` → sin formato) y `AI_RESPONSE_FORMAT`
- [X] T2 Conversor Zod → JSON Schema estricto + `stripNulls`
- [X] T3 Códigos de error explícitos (`errors.ts`) y política de reintentos por clase
- [X] T4 Recuperación de texto plano en 3 capas (`recovery.ts`)
- [X] T5 Política de handoff: formato ≠ error del proveedor; degradación segura (`AI_FALLBACK_MESSAGE`)
- [X] T6 Logs por lista blanca; `describeError`; juez y transcripción sin contenido en logs
- [X] T7 Pruebas: adaptador, conversor, recuperación, pipeline (incidente), E2E

## Rev. 2 (preproducción)

- [X] T-R1 Presupuesto compartido por turno (`budget.ts`), ≤ 3 llamadas; sólo formato ≤ 2; matriz de 512 secuencias
- [X] T-R2 `classifyRejection`: sólo señal explícita baja de formato; códigos `schema_rejected`, `model_not_found`, `invalid_request`; pruebas por causa
- [X] T-R3 Migración `0022` + `failure-state.ts` (atómico) + reinicios (turno exitoso, reactivar IA, reset del bot); verificado en Postgres real
- [X] T-R4 Circuito por organización+modelo (`circuit.ts`) + aviso único por conversación + `markAiError` en 401
- [X] T-R5 `resolveEffectiveModel` / `effectiveAiModels` + `effective` en `GET /api/settings/ai`
- [X] T-R6 Registro de esquemas (`schemas.ts`) + prueba de contrato con escaneo del código; conversor sin `anyOf` anidado
- [X] T-R10 Cierre (rev. 3): E2E sin esperas fijas en turnos de agente (causa medida en frío, 10/10), migración con `lock_timeout` verificada (idempotencia, bloqueo, compatibilidad, concurrencia), `maxTokens`, costo y criterios de la prueba real
- [ ] T-R7 Prueba real contra OpenRouter (`pnpm test:ai-live`): **preparada, con triple candado, NO ejecutada** — requiere autorización inmediata antes de consumir saldo
- [X] T-R8 Spec, plan, data-model, contrato `ai.md`, CLAUDE.md, guion E2E actualizados
- [X] T-R9 Validación completa: unitarias, suite, typecheck, lint, build, E2E, Postgres real
