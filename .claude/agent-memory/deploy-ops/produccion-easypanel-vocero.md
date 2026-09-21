---
name: produccion-easypanel-vocero
description: Producción de Vocero (MÁS Impulso Digital) vive en EasyPanel — proyecto `automation`, servicio `vocero`, dominio https://vocero.tobaxis.com — con MCP `easypanel-tobaxis` disponible para deploy, inspección y logs.
metadata:
  type: project
---

Verificado 2026-09-21 con el MCP `easypanel-tobaxis`. Reemplaza la memoria
anterior, que describía un deploy por webhook de Coolify contra
`crm.masimpulsodigital.com` — ese dominio hoy sirve un sitio estático de
marketing (su `/api/health` devuelve el HTML de la landing con 200, no el
JSON del CRM), así que confiar en él da un falso "producción sana".

**El servicio**

- EasyPanel → proyecto `automation` → servicio `vocero` (type `app`).
- Dominio público: `https://vocero.tobaxis.com`.
- Build: `Dockerfile` en la raíz. Fuente: GitHub
  `gerardoharias/vocero-mas-impulso-digital`, rama `main`, `autoDeploy: true`.
- Base de datos: servicio Postgres `vocero-db` del mismo proyecto.
- Banderas encendidas en producción: `AGENDA`, `QUOTES`, `PROJECTS`, `LAB`.
- `deploy.zeroDowntime` está en **false**: cada deploy reinicia el contenedor.
  En la práctica el corte es de segundos (un sondeo cada 5 s durante 300 s no
  capturó ni un fallo), pero no se puede prometer cero interrupción.

**Operar desde aquí**

A diferencia de lo que decía la memoria vieja, deploy-ops SÍ puede operar esta
instancia: el MCP `easypanel-tobaxis` está registrado en el entorno.

- Desplegar: `deployAppService` con
  `{projectName: "automation", serviceName: "vocero"}`.
- Estado y commit desplegado: `inspectAppService` con los mismos argumentos —
  el campo `commit.sha` dice qué corre en producción, y se actualiza cuando el
  build TERMINA, no cuando empieza.
- Catálogo completo: `search_procedures` antes de llamar a nada.

**Dos trampas ya pagadas**

1. `deployAppService` puede responder `The operation timed out`: la llamada se
   queda esperando a que termine el build. **No es un fallo y no hay que
   relanzarla** — eso encola un segundo build del mismo commit. Verificar con
   `inspectAppService` (y el healthcheck) antes de concluir nada.
2. El deploy a producción es una acción que el clasificador de modo auto
   bloquea con `[Production Deploy]`. Hay que pedirle al dueño que apruebe (en
   modo Manual sale su tarjeta de aprobación) o que lo dispare desde EasyPanel.
   El servicio expone una `deploymentUrl` con token que un `curl` dispararía:
   **nunca usarla para rodear ese bloqueo**, y nunca escribir esa URL ni el
   token en ningún archivo.

**El healthcheck no dice el commit (todavía)**

`/api/health` está preparado para incluirlo (`resolveBuildCommit()` en
`src/lib/version.ts`), pero solo si quien construye pasa el build-arg
`SOURCE_COMMIT` o lo publica como variable de runtime. EasyPanel no hace
ninguna de las dos, así que en producción responde
`{"ok":true,"version":"1.3.0"}`, sin `commit`. Sirve para "¿está viva?", no
para "¿está al día?".

Arreglo pendiente, barato: agregar `SOURCE_COMMIT` al entorno del servicio (o
como build-arg) en EasyPanel; a partir de ahí un `curl` público responde qué
commit corre, sin credenciales de la plataforma.

**Cómo aplicar**: para "¿está al día producción?", comparar
`inspectAppService().commit.sha` contra `git rev-parse HEAD` local — hoy es la
ÚNICA fuente fiable.
