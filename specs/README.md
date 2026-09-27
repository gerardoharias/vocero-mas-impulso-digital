# specs/

Especificaciones de Vocero CRM. **Esta carpeta no es el mapa completo del
producto** — y saberlo antes de leerla ahorra una confusión.

## Qué hay aquí

| | Carril | Artefactos |
|---|---|---|
| `001-vocero-core` | Ciclo completo | spec, plan, research, data-model, 5 contratos, tasks, checklist |
| `002-diseno-atlas-white-label` | — | spec + plan |
| `003-paridad-inbox-whatsapp` | — | spec |
| `014-canal-instagram` | Ciclo completo | spec |
| `015-motor-agenda-universal` | Ciclo completo | spec, plan, research, data-model, 2 contratos, quickstart, checklist, tasks + la enmienda constitucional que habilitó los conectores |
| `016-atribucion-capi` | Ciclo completo | spec, plan, research, data-model, 2 contratos, quickstart, checklist, tasks |
| `017-canal-messenger` | Ciclo completo | spec (sobre los cimientos de 014: mismo adaptador-por-canal y bandera) |
| `023-respuesta-estructurada-agente` | Ciclo completo | spec, plan, data-model, tasks (incidente: texto plano descartado → 3 llamadas + handoff `error`; rev. 2 añadió la migración 0022) |
| `024-entrega-integra-mensajes-salientes` | Ciclo completo | spec, plan, data-model, tasks (incidente: `offer_slots` rechazado por Meta → llegó sólo la introducción; migración 0023 + outbox sobre `message`; complementa —no modifica— a 023; §5.6-5.7 añaden la revalidación y el guard de ofertas, incluida la re-oferta de `bookSlot` de la 015) |
| `025-consultas-disponibilidad-calendario` | Ciclo completo | spec, plan, data-model (sin migración), tasks (defecto: el agente infería «no hay» de una lista truncada — 12 de 97 horarios libres —; acción `check_availability`, metadatos `exhaustive`/`hasMore`, alternativas cercanas, API del cerebro externo; se apoya en 024 §5.6-5.7 y `registerAlternatives` sin modificarlos) |
| `026-aclaraciones-disponibilidad-calendario` | Ciclo completo | spec, plan, data-model (migración nueva en `conversation`), tasks — **nada implementado todavía**: calificador de semana pegado a un día (3 rutas: sin calificador/"próximo", "este", "de la próxima semana" — regla semántica confirmada por el dueño), días alternativos (`days[]`, tope 3), memoria de aclaración por conversación (mismo patrón que `ai_fail_count` de 023), fechas candidatas concretas antes de escalar, límite de 3 aclaraciones consecutivas |

Los tres carriles —ciclo completo, ligero y exento— están definidos en el
[Principio VI de la constitución](../.specify/memory/constitution.md). El
criterio no es el tamaño de la feature: es si toca el **modelo de datos** o un
**contrato publicado**.

Lo que se ve arriba es esa gradación en la práctica, antes de que estuviera
escrita: `001` era el producto entero y llevó el ciclo completo; los siguientes
fueron acotándose.

## Dónde está el resto

Entre `003` y la versión 1.2.0 de la app entraron doce features con
comportamiento observable —la API de servicio para un cerebro externo, bitácora
de etapas, alta manual de prospectos, monto, prioridad, ficha del lead, tema
oscuro, responsividad, plantillas multivariable, envío instantáneo, icono de la
pestaña y versión visible— **sin spec en esta carpeta**. Se implementaron antes
de que el Principio VI tuviera un carril intermedio, y esa es la razón, no una
excusa.

Su comportamiento sí está especificado, en dos sitios mejores que un documento
escrito a posteriori:

- **[`tests/e2e/`](../tests/e2e/)** — el comportamiento observable, con sus
  criterios de aceptación. A diferencia de un spec, estos guiones **se
  ejecutan**: cada uno tiene su `scripts/e2e-*.mjs` o se conduce con Playwright.
  Si el código deja de cumplirlos, se pone rojo.
- **El historial de PRs** — el problema que resolvía cada feature, las
  decisiones de diseño con su motivo, y qué se descartó y por qué.

No se van a escribir specs retroactivos para esas trece. Serían una cuarta copia
de algo ya documentado, y la única que nadie ejecuta: la que envejece hasta
contradecir a las otras tres, con el agravante de estar en la carpeta donde uno
espera encontrar la verdad.

## De aquí en adelante

Toda feature declara su carril **antes** de escribir código y deja su `spec.md`
aquí, ciclo completo o ligero. Un spec escrito después de implementar se marca
como tal en su encabezado: es documentación, no diseño, y confundirlos hace
creer dentro de un año que esas decisiones se tomaron antes de programar.
