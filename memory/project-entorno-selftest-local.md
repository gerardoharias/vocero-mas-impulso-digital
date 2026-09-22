---
name: project-entorno-selftest-local
description: Cómo dejar corriendo el self-test de comportamiento en la Mac de Gerardo — postgres en 5433 (el 5432 está ocupado por otro proyecto), app en 3100 y los GOOGLE_*_BASE_URL del mock que .env no trae
metadata:
  type: project
---

Verificado el 2026-09-19 levantando el arnés de punta a punta para el arreglo
del conector de Google.

**Puertos**: `.env` apunta a `postgres://…@localhost:5433/vocero`, pero
`docker-compose.dev.yml` mapea `5432:5432` — y el 5432 de esta Mac lo ocupa
`postgres_db`, de otro proyecto. Levantar el compose tal cual NO sirve. Lo que
funciona es un contenedor dedicado:

```bash
docker run -d --name vocero-dev-pg-5433 -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=<el de .env> -e POSTGRES_DB=vocero \
  -p 5433:5432 postgres:16-alpine
```

Después `pnpm db:migrate` (sin esto `/api/health` da 503 y Better Auth revienta
con `relation "user" does not exist`). La app corre en **3100**, no 3000
(`.claude/launch.json` → `preview_start` con `name: "vocero-dev"`).

**`.env` local viene INCOMPLETO y los huecos fallan en silencio.** Faltaban
cuatro cosas, y ninguna da un error claro:

- `OPENROUTER_MODEL` — con token pero sin modelo, `chatJson` devuelve
  `not_configured` y el pipeline hace `return` SIN escalar ni avisar: el agente
  simplemente nunca contesta. Esto es lo que hacía fallar el check "el agente
  respondió por WhatsApp" de `scripts/qa-simular-prospecto.mjs`, que el
  2026-09-19 di por "fallo preexistente de la ruta del ai-mock" — no lo era.
- `GOOGLE_CAL_BASE_URL` y `GOOGLE_OAUTH_BASE_URL` → el google-mock; si no, el
  conector sale a Google de verdad y cuelga con ENOTFOUND.
- `ZOOM_BASE_URL` y `ZOOM_OAUTH_BASE_URL` → el zoom-mock; si no, 5 checks de
  agenda fallan encadenados desde "credenciales válidas se guardan".

Todos apuntan a `http://localhost:3100/api/dev/<mock>`. En producción van SIN
definir.

**Cómo aplica**: con `.env` completo, `node --env-file=.env
scripts/e2e-selftest.mjs` da **209/209 en verde** (2026-09-19) — ése es el
listón, no "falla algo de antes". Antes de atribuir un FAIL a código
preexistente, revisa que no sea un hueco de `.env`: este arnés degrada callado
cuando falta una variable. `scripts/qa-simular-prospecto.mjs` es el otro arnés,
el que ejercita el conector de agenda de punta a punta
(`PUT /api/settings/google` → `testConnection`).

## La agenda del Postgres de desarrollo se saturaba con las corridas (2026-09-21)

Cada corrida deja citas reales (`booking`, `status='agendada'`) en los días
próximos y nada las retiraba. Tras ~10 corridas contra la misma base, los días
de la ventana (`maxDaysAhead: 7`, huecos de 30 min entre 09:00 y 18:00)
quedaban llenos y el check **"el reparto cubre más de un día (no todo hoy)"**
se ponía rojo con `diasConAgenda: ["<un solo día>"]` — sin nada roto en el
producto: `/api/bot/availability` decía la verdad.

**Ya está resuelto en el arnés**: `cancelarCitasDelArnes()` corre al empezar
(barre lo que dejaron corridas anteriores) y al terminar `agendaChecks()`
(cancela lo de la corrida en curso). Se ata a los NOMBRES de los contactos que
el guion inventa (`Lead agenda…`, `Lead cita cancelada…`, `Rescate …`) y
respeta a propósito los de `scripts/qa-simular-prospecto.mjs` ("Prospecto QA").
Si el check vuelve a ponerse rojo, comprobar primero que la limpieza corrió —
imprime `(limpieza …: N citas del arnés canceladas)`:

```bash
docker exec vocero-dev-pg-5433 psql -U postgres -d vocero -c "select date(scheduled_at) dia, count(*) from booking where is_test=false and status in ('agendada','realizada') group by 1 order by 1;"
```

Un día con ~13 citas de 30 min repartidas cada 40 minutos está lleno de verdad.
