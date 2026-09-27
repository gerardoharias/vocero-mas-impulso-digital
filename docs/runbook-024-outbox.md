# Runbook de despliegue — spec 024 (outbox de mensajes salientes, migración 0023)

Esta versión persiste cada mensaje saliente **antes** de enviarlo, reintenta los
fallos temporales de Meta con el **mismo texto** y deja los resultados ambiguos en
«Sin confirmar». Añade una migración (**0023**, aditiva) y un trabajador en
segundo plano dentro del mismo proceso de la app. No hay servicios nuevos.

> Convenciones: `<DOMAIN>` es el dominio de la instancia. `$PSQL` es tu forma de
> abrir `psql` contra la base de **esa** instancia:
> - Ruta B (compose): `PSQL="docker compose exec -T postgres psql -U postgres -d vocero"`
> - Ruta A (Coolify): `PSQL='psql "$DATABASE_URL"'` desde la terminal del servicio de la app o de la base.
>
> Ningún paso de este documento envía mensajes a prospectos ni usa teléfonos o
> credenciales reales.

## 0. Qué cambia para quien opera

- Un mensaje con un fallo temporal ya **no** aparece como «No se entregó»: aparece
  «Reintentando…» y, si se recupera, queda como enviado (una sola burbuja).
- Un resultado ambiguo aparece como «Sin confirmar» con un botón **Reenviar**: no
  se reenvía solo, para no duplicarlo.
- Un cerebro externo (`POST /api/bot/messages`) recibe `200 {status:"retrying"}` en
  vez de `502` ante un fallo temporal. Avísales **antes** del despliegue:
  [`docs/bot-messages-contrato.md`](bot-messages-contrato.md).
- Variables nuevas, **todas opcionales** (`OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_CAP_MS`,
  `OUTBOX_POLL_MS`): los valores por defecto son los recomendados. No hay secretos nuevos.

## 1. Comprobaciones previas (no desplegar si alguna falla)

1. **El commit pasó las cuatro compuertas y la integración**: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build`, y el E2E (`pnpm test:e2e`) contra los mocks.
2. **Versión de PostgreSQL ≥ 13** (recomendado 16):
   ```bash
   $PSQL -Atc "show server_version;"
   ```
3. **La base está sana y al día hasta la 0022** (la 0023 debe ser la única pendiente):
   ```bash
   $PSQL -Atc "select count(*) from drizzle.__drizzle_migrations;"     # anota el número: N
   ```
4. **Sin transacciones largas** sobre `message`/`offered_slot` (la migración usa `lock_timeout = 3s` y reintenta, pero conviene no depender de ello):
   ```bash
   $PSQL -c "select pid, now()-xact_start as edad, state, left(query,60) q
             from pg_stat_activity
             where xact_start is not null and now()-xact_start > interval '30 seconds' and pid <> pg_backend_pid();"
   ```
   Debe devolver 0 filas.
5. **Línea base** de mensajes (guárdala para comparar después):
   ```bash
   $PSQL -c "select direction, status, count(*) from message group by 1,2 order by 1,2;"
   ```
6. **La instancia actual responde**: `curl -s https://<DOMAIN>/api/health` → `{"ok":true,"version":"…"}`.
7. **Aviso a integradores** del cambio de `POST /api/bot/messages` (sección 0).
8. Ventana de despliegue con poco tráfico (no es obligatorio, pero acota el drenado de la sección 8).

## 2. Respaldo (obligatorio antes de migrar)

```bash
# Ruta B
docker compose exec -T postgres pg_dump -U postgres -Fc vocero > "vocero-pre-0023-$(date +%F-%H%M).dump"
# Comprobar que el archivo es legible y no está vacío:
pg_restore -l "vocero-pre-0023-<fecha>.dump" | head -20
ls -l "vocero-pre-0023-<fecha>.dump"
```

En Coolify, toma además un snapshot/backup programado de la base desde el panel y
anota su identificador. Guarda el respaldo **fuera** del servidor. La migración es
aditiva (no borra ni reescribe nada), así que el respaldo es la red de seguridad
para un problema imprevisto, no un paso de la reversión normal (sección 9).

## 3. Aplicación y verificación de la migración 0023

La migración corre **sola al arrancar el contenedor** (`node migrate.mjs && node server.js`).
No hay paso manual. Con la imagen nueva:

```bash
# Ruta B
docker compose up -d --build app
docker compose logs -f app | grep -E "migrate|outbox|Ready|error"
```

Debes ver, en este orden: `[migrate] migraciones aplicadas` → el arranque de Next →
`[outbox] trabajador iniciado (sondeo cada 5000 ms)`.

- Si aparece `BD no lista (intento n/15)` una o dos veces: es el `lock_timeout` de 3 s
  cediendo ante una transacción larga; reintenta solo. Si llega a 15 → sección 9 (abortar).
- **La migración es re-ejecutable**: correrla otra vez no hace nada.

### Verificación (todas deben cumplirse)

```bash
# a) Se registró UNA migración más (N+1)
$PSQL -Atc "select count(*) from drizzle.__drizzle_migrations;"

# b) Columnas nuevas de message  → 9 filas
$PSQL -Atc "select column_name from information_schema.columns
            where table_name='message'
              and column_name in ('delivery_attempts','next_attempt_at','locked_until','error_code',
                                  'error_subcode','error_class','trace_id','dedupe_key','offer_state')
            order by 1;"

# c) Columnas nuevas de offered_slot → message_id, shown, state
$PSQL -Atc "select column_name from information_schema.columns
            where table_name='offered_slot' and column_name in ('message_id','state','shown') order by 1;"

# d) Tabla de intentos, trigger de inmutabilidad e índices  → 1, 1, 3
$PSQL -Atc "select count(*) from information_schema.tables where table_name='message_delivery_attempt';"
$PSQL -Atc "select count(*) from pg_trigger where tgname='message_out_text_immutable_trg';"
$PSQL -Atc "select count(*) from pg_indexes where indexname in
            ('message_outbox_due_idx','message_delivery_attempt_msg_no_uq','offered_slot_message_idx');"

# e) Lo anterior quedó intacto: mismos totales que la línea base (sección 1.5) y ningún saliente reescrito
$PSQL -c "select direction, status, count(*) from message group by 1,2 order by 1,2;"
$PSQL -Atc "select count(*) from offered_slot where message_id is null and state <> 'active';"   # 0: lo anterior sigue seleccionable
```

## 4. El trabajador del outbox arrancó

```bash
# 1) El healthcheck lo declara (booleano; sin cifras del negocio)
curl -s https://<DOMAIN>/api/health
# → {"ok":true,"version":"…","outbox":{"worker":true}}

# 2) Exactamente UNA línea de arranque por proceso
docker compose logs app | grep -c "trabajador iniciado"        # 1 (por contenedor)
```

Si `outbox.worker` es `false` pasados 2 minutos del arranque → **criterio de reversión
(sección 9)**: sin trabajador, los reintentos no salen (los envíos normales sí).

## 5. Conteo de mensajes en vuelo

```sql
select status, count(*) as n,
       coalesce(max(now() - coalesce(next_attempt_at, locked_until, created_at)), interval '0') as mas_antiguo
from message
where direction = 'out'
  and status in ('queued','sending','retrying','delivery_unknown')
group by status
order by status;
```

Lectura normal: `queued` y `sending` en **0** (duran milisegundos); `retrying` en 0 salvo
durante un incidente de Meta (segundos); `delivery_unknown` sin crecer.

## 6. Pruebas de humo (sin prospectos reales)

**Nunca** uses `wa-mock` en producción: su superficie responde `404` por diseño.

1. **Los mocks siguen apagados en producción** (debe dar 404):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<DOMAIN>/api/dev/wa-mock/fail-next     # 404
   ```
2. **Laboratorio (sandbox)**: en la app, Laboratorio → correr una prueba que ofrezca
   horarios. Los mensajes de prueba (`is_test`) **jamás** llegan a Meta ni entran al outbox:
   ```sql
   select count(*) from message m join conversation c on c.id = m.conversation_id
   where c.is_test and m.status in ('queued','sending','retrying');     -- 0
   ```
3. **Migración sobre datos reales, sólo lectura**: los mensajes anteriores conservan su texto
   y estado; los horarios anteriores siguen `active`:
   ```sql
   select count(*) from offered_slot where state = 'active';            -- lo mismo que antes
   ```
4. **Estado de una instancia de staging** (recomendado antes de producción): levanta una copia con
   `WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL=<staging>/api/dev/wa-mock/graph` y
   `OPENROUTER_BASE_URL=<staging>/api/dev/ai-mock`, y corre `pnpm test:e2e` contra ella
   (incluye el incidente: rechazo temporal → reintento íntegro, permanente, ambiguo, reenvío
   manual y el guard de ofertas).
5. **Primer mensaje real, sólo observación**: no fuerces envíos. Cuando salga el primer saliente
   legítimo del día, comprueba que se registró su intento:
   ```sql
   select a.attempt_no, a.outcome, a.stage, m.status
   from message_delivery_attempt a join message m on m.id = a.message_id
   order by a.started_at desc limit 5;         -- outcome = accepted, attempt_no = 1
   ```
   Si quieres una prueba activa, hazla **únicamente** con un número propio del negocio que haya
   dado su consentimiento — nunca con prospectos.

## 7. Métricas y eventos a vigilar (primeras 24 h)

Eventos en logs (todos llevan sólo `msg=<id> trace=<id> attempt=<n>` y códigos; ni teléfonos,
ni texto, ni tokens):

| Log | Significa | Alerta si… |
|---|---|---|
| `[outbox] retrying … cls=transient code=…` | Fallo temporal, se reintenta | Ráfaga sostenida (> 5 % de los envíos): Meta tiene un incidente |
| `[outbox] failed … cls=…` | Cierre definitivo | `cls=auth` (token vencido) o `cls=permanent` con un mismo código repetido |
| `[outbox] delivery_unknown …` | Resultado ambiguo | Cualquiera: alguien debe mirar la bandeja |
| `[outbox] orphan_unknown …` | El proceso murió con un envío en vuelo | Más de 1 por reinicio |
| `[outbox] barrido falló` | Error del trabajador | Repetido |
| `[agente] respuesta de agenda no entregada` | El envío de una respuesta del agente falló definitivamente | Sube de golpe |

Consultas de vigilancia:

```sql
-- Cierres por clase (últimas 24 h)
select coalesce(error_class,'-') clase, error_code, count(*)
from message where direction='out' and status in ('failed','delivery_unknown')
  and created_at > now() - interval '24 hours'
group by 1,2 order by 3 desc;

-- Reintentos por resultado (últimas 24 h): la mayoría debe terminar en accepted
select outcome, count(*) from message_delivery_attempt
where started_at > now() - interval '24 hours' group by 1 order by 2 desc;

-- INVARIANTE 1: ningún envío «sending» con arrendamiento vencido (0)
select count(*) from message where status='sending' and locked_until < now() - interval '90 seconds';

-- INVARIANTE 2: ninguna oferta con mensaje ya aceptado y horarios sin activar (0)
select count(*) from message
where offer_state = 'pending' and status in ('pending','sent','delivered','read');

-- INVARIANTE 3: ninguna respuesta del agente duplicada para el mismo entrante (0 filas)
select dedupe_key, count(*) from message where dedupe_key is not null group by 1 having count(*) > 1;

-- Posibles duplicados visibles al prospecto: mismo texto saliente dos veces en 5 min (0 filas)
select conversation_id, text, count(*) from message
where direction='out' and created_at > now() - interval '24 hours' and text is not null
group by 1,2 having count(*) > 1
   and max(created_at) - min(created_at) < interval '5 minutes';
```

Señales de producto: conversaciones «pendientes de responder» (`failed` o `delivery_unknown`
como último mensaje) y ofertas rechazadas por obsolescencia (`error_class = 'offer_stale'`),
que son esperables y baratas.

## 8. Drenar mensajes antes de revertir

Sólo si vas a **volver a la versión anterior**. Objetivo: que no queden mensajes en estados que
el código anterior no entiende (`queued`, `sending`, `retrying`).

1. **Frena lo nuevo**: en la app, Agente → apaga el agente integrado (y avisa al cerebro externo
   si lo hay). El operador evita enviar durante el drenado.
2. **Espera a que el trabajador vacíe** (máx. ≈ 3 minutos: el peor backoff es 2.5 min):
   ```sql
   select status, count(*) from message
   where status in ('queued','sending','retrying') group by 1;
   ```
   Repite cada 30 s hasta que no devuelva filas.
3. **Resuelve `delivery_unknown`** (no se reenvían solos): revisa cada uno en la bandeja
   («Sin confirmar»): si el prospecto ya respondió o el mensaje llegó, déjalo; si no, **Reenviar**.
   Para que el código anterior los cuente como «pendiente de responder», tras revisarlos:
   ```sql
   update message set status = 'failed'
   where status = 'delivery_unknown' and direction = 'out';
   ```
4. **Último recurso** (si tras 10 minutos siguen `queued/sending/retrying`, p. ej. porque el
   trabajador murió): confirma que **ningún proceso de la versión nueva sigue corriendo** y ciérralos
   sin enviarlos (el texto se conserva para reenviarlos a mano):
   ```sql
   update message
      set status = 'failed',
          error = 'Interrumpido por una reversión: no se envió. Reenvía manualmente.'
    where direction = 'out' and status in ('queued','sending','retrying');
   ```
5. **Comprobación final**: el conteo de la sección 5 sólo muestra `delivery_unknown` (0 si aplicaste el paso 3).
6. Despliega la versión anterior. **No hace falta deshacer la migración.**

## 9. Criterios para abortar o revertir

**Abortar antes de migrar** (no desplegar): falla una comprobación de la sección 1; el respaldo no
se pudo leer; hay transacciones largas que no ceden.

**Abortar durante el arranque**: `BD no lista (intento 15/15)` (la migración no consiguió el bloqueo
en 15 intentos). En Coolify el contenedor nuevo no pasa el healthcheck y **el anterior sigue sirviendo**;
en compose, `docker compose up -d app` de la versión anterior. La migración es transaccional: una
falla a medias no deja columnas a medias.

**Revertir después de desplegar** si ocurre **cualquiera** de estas, en las primeras 24 h:

| Señal | Umbral |
|---|---|
| `outbox.worker` en `/api/health` | `false` pasados 2 min del arranque |
| Mensajes duplicados visibles al prospecto (consulta de duplicados, sección 7) | ≥ 1 caso confirmado que **no** sea un reenvío manual |
| `sending` huérfanos (invariante 1) | ≥ 1 que no se resuelva en 5 min |
| Ofertas aceptadas sin activar (invariante 2) | ≥ 1 |
| Respuestas del agente duplicadas (invariante 3) | ≥ 1 |
| `[outbox] barrido falló` | repetido durante > 5 min |
| Los prospectos no pueden elegir horarios tras recibir una oferta | ≥ 1 caso reproducible |

**No** son motivo de reversión: `retrying` durante un incidente real de Meta; `delivery_unknown` aislados
(es exactamente su función); `offer_stale` (una oferta que dejó de estar libre).

## 10. Compatibilidad de la versión anterior con la base migrada

La migración es **aditiva**, así que la versión anterior funciona sobre la base migrada:

- Las columnas nuevas son nulas o tienen `DEFAULT`; la versión anterior no las nombra y no falla.
- Sus `INSERT` de `message`/`offered_slot` (sin las columnas nuevas) son válidos; los horarios que
  inserta quedan `active`, que es lo que ella espera.
- El trigger sólo actúa si alguien cambia el `text` de un saliente; la versión anterior nunca lo hace.
- Su migrador sobre la carpeta `drizzle/` antigua **no aplica ni falla** con la 0023 ya registrada
  (sólo aplica lo posterior a la última migración registrada).
- Lo único que no entiende son los estados `queued/sending/retrying/delivery_unknown` (los pintaría
  como fallo): de ahí el drenado de la sección 8.

Todo esto está probado contra Postgres real en `tests/integration/outbound-migration.test.ts`
(migrador anterior sin cambios, `INSERT`/`UPDATE` del código anterior, defaults).

**Deshacer la migración no se recomienda** (perdería el historial de intentos y de rondas). Si un
requisito externo lo exigiera, tras drenar y con el respaldo verificado:
`DROP TRIGGER message_out_text_immutable_trg ON message; DROP FUNCTION message_out_text_immutable();`
y `ALTER TABLE … DROP COLUMN` de las columnas nuevas (`message`: `delivery_attempts`, `next_attempt_at`,
`locked_until`, `error_code`, `error_subcode`, `error_class`, `trace_id`, `dedupe_key`, `offer_state`;
`offered_slot`: `message_id`, `state`, `shown`) y `DROP TABLE message_delivery_attempt`. Después borra la
fila de `drizzle.__drizzle_migrations` de la 0023 (la última).

## 11. Lista final

- [ ] Sección 1 completa · respaldo verificado · integradores avisados
- [ ] `[migrate] migraciones aplicadas` y las verificaciones a–e de la sección 3
- [ ] `/api/health` → `outbox.worker: true` · una línea `trabajador iniciado`
- [ ] Conteo de la sección 5 sin `queued`/`sending`
- [ ] `wa-mock` responde 404 · Laboratorio sin mensajes en el outbox
- [ ] Invariantes 1, 2 y 3 en 0 a la hora, a las 6 h y a las 24 h
