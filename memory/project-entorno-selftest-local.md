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
