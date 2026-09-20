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

**Los mocks de Google no vienen en `.env`.** Sin ellos el conector sale a
Google de verdad y el self-test se cuelga con ENOTFOUND. Hay que agregar
`GOOGLE_CAL_BASE_URL` y `GOOGLE_OAUTH_BASE_URL` apuntando a
`http://localhost:3100/api/dev/google-mock`. En producción van SIN definir.

**Cómo aplica**: `scripts/qa-simular-prospecto.mjs` es el arnés que ejercita el
conector de agenda de punta a punta (`PUT /api/settings/google` →
`testConnection`), y es lo que prueba de verdad un cambio ahí — no lo cubre
`scripts/e2e-selftest.mjs`. Ojo con un falso positivo al leer su salida: el
check **"el agente respondió por WhatsApp" ya falla en `main`** por la ruta del
ai-mock, no por lo que estés tocando. Antes de atribuirte un FAIL, corre el
script con tus cambios en stash y compara — ver
[[feedback-bot-no-responde-diagnostico]].
