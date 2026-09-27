# Guion E2E — US6: Plantillas

> Conducido con Playwright (MCP) contra `pnpm dev` con wa-mock.

## Ciclo de aprobación

1. En `/settings/templates`: crear `seguimiento_cotizacion` (es_MX, UTILITY,
   cuerpo con `{{1}}`).
   ✅ Queda en estado "Pendiente de Meta" (el mock devuelve PENDING).
2. Simular la aprobación: `POST /api/dev/wa-mock/template-status`
   `{ wabaId, name, language, event: "APPROVED" }`.
   ✅ El estado pasa a "Aprobada" (evento webhook enrutado por entry.id).
3. Camino infeliz: crear `promo_rechazada` y simular `REJECTED` con razón.
   ✅ Estado "Rechazada" mostrando la razón.
4. `POST /api/templates/sync` → 200 (pull por Graph; cubre modo agencia).

## Modo agencia: aprobación que NUNCA llega por webhook

> Automatizado en `scripts/e2e-templates-sync.mjs` (13 checks) + comprobación
> de UI con Playwright. Reproduce un fallo visto en producción.

`message_template_status_update` se entrega al callback **a nivel app**, que en
modo agencia no es el de esta instancia: sin pull, la plantilla se queda
"Pendiente de Meta" para siempre aunque Meta ya la haya aprobado.

8. Crear plantilla (UTILITY) y mover el panel simulado de Meta con
   `POST /api/dev/wa-mock/template-status` `{ event: "APPROVED",
   category: "MARKETING", notify: false }` — `notify:false` NO entrega webhook.
   ✅ El CRM sigue en "Pendiente de Meta" (el bug reproducido).
9. `POST /api/templates/sync`.
   ✅ `updated: 1`, estado "Aprobada" y categoría **MARKETING** (Meta es la
   autoridad de la categoría: reclasifica al aprobar y eso cambia el costo).
   ✅ Un segundo sync devuelve `updated: 0` (idempotente).
10. Abrir `/settings/templates` con la plantilla en pending y Meta ya aprobada.
    ✅ El badge muestra "Aprobada" **sin tocar Sincronizar** (auto-sync al
    montar); si el pull falla, la lista local se pinta igual y el error se
    calla (solo el botón manual reporta errores).

## Envío con ventana cerrada

5. Abrir una conversación con ventana cerrada en la bandeja.
   ✅ El composer bloqueado ahora lista la plantilla aprobada.
6. Elegirla, llenar la variable y enviar.
   ✅ El mensaje aparece en el hilo (tipo plantilla, cuerpo renderizado).
   ✅ El outbox del wa-mock registra `type: "template"` con `components`
   (`parameters[0].text` = valor de la variable).
7. Validaciones: enviar plantilla no aprobada → 422; variable faltante → 422.

## Varias variables por cuerpo (2026-08-09)

> Automatizado en `scripts/e2e-templates-multivar.mjs` (21 checks) + UI con
> Playwright. Antes el CRM rechazaba en su propia pantalla lo que Meta sí
> acepta: "v1 admite una sola variable {{1}} en el cuerpo".

11. En `/settings/templates`, cuerpo con `{{1}}`, `{{2}}` y `{{3}}`.
    ✅ Sin aviso rojo, el botón habilitado y la pantalla anuncia "3 variables".
    ✅ A Meta va **un `example.body_text` por variable** (sin eso responde 100).
12. Cuerpo con salto (`{{1}}` y `{{3}}`).
    ✅ Aviso "…sin saltos (falta {{2}})", botón deshabilitado y, si se fuerza
    por API, 422 — la numeración posicional contigua es requisito de Meta.
13. Con la plantilla aprobada y la ventana cerrada, el envío pide **un campo por
    variable** (`Valor de {{1}}`…`{{3}}`).
    ✅ El outbox del wa-mock trae los 3 `parameters` en orden y el hilo muestra
    el texto ya sustituido.
    ✅ Faltando un valor → 422 diciendo cuál falta; el wa-mock además replica el
    132000 de Meta si el número de parámetros no cuadra.
14. Compatibilidad: el payload viejo `{ templateId, variable }` (una variable)
    sigue enviando — lo usa el cron de recordatorios de sesión.

## Plantilla genérica fuera de ventana (2026-09-27)

> Automatizado en `scripts/e2e-selftest.mjs` (`plantillaGenericaChecks`, 22
> checks) + UI con el navegador. Con la ventana de 24 h cerrada, lo que el
> operador escribe en el chat sale como `{{1}}` de la plantilla marcada como
> genérica — sin elegir plantilla ni llenar campos.

15. Crear `aviso_general` con cuerpo
    `Dando seguimiento a la cita agendada.\n{{1}}\n\nSaludos!`.
    ✅ Nace sin marca de genérica.
    ✅ Un cuerpo que **empieza o termina** en variable → 422 (Meta lo rechaza);
    la pantalla lo avisa antes de gastar la llamada.
16. `PATCH /api/templates/:id { isWindowFallback: true }` (casilla "Usar para
    mensajes fuera de 24 h" en `/settings/templates`).
    ✅ Solo plantillas de **exactamente una variable** (otra → 422).
    ✅ A lo más una por organización: marcar B desmarca A (índice único parcial
    `template_org_window_fallback_uq`).
    ✅ La marca es local: aprobar/sincronizar con Meta no la toca.
17. Conversación con la ventana cerrada (contacto capturado a mano).
    ✅ El texto libre sigue prohibido en el núcleo: `POST …/messages` → 409
    `window_closed`.
    ✅ El composer muestra el campo de texto normal con el aviso "se enviará
    dentro de la plantilla…", vista previa y contador (1024 del cuerpo ya
    renderizado). Adjuntos/ubicación/contacto no aplican.
18. Escribir "Le recuerdo que tiene una cita agendada⏎para mañana a las 10 am"
    y enviar.
    ✅ El outbox del wa-mock trae `type: "template"`, el nombre de la genérica y
    `parameters[0].text` **en un solo renglón** (Meta 132018 rechaza saltos,
    tabs y más de 4 espacios en un parámetro; se sanea siempre, en toda
    plantilla).
    ✅ El hilo muestra la plantilla completa ya sustituida.
19. Caminos infelices: cuerpo renderizado > 1024 → 422 diciendo cuánto sobra;
    solo espacios/saltos → 422 (valor faltante). Sin genérica aprobada, el
    composer vuelve al selector de siempre con la pista de cómo activarla;
    "Usar otra plantilla" abre ese mismo selector.
