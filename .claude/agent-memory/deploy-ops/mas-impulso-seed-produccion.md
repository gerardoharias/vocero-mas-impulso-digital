---
name: mas-impulso-seed-produccion
description: Cómo y dónde correr el seed del agente MÁS Impulso Digital en producción — nunca desde este checkout de dev.
metadata:
  type: project
---

El seed del agente comercial de MÁS Impulso Digital (`agent_profile` + KB,
commits `abbdf3f`/`709d129`) requiere `organization_id` explícito en cuanto
haya más de una organización en la base — que es el caso esperado en
producción; sin argumento solo funciona con exactamente una organización.

Desde el Dockerfile se bundlea junto con el build (mismo patrón que
`seed-demo.mjs`, no depende de devDependencies) y queda disponible en el
contenedor de runtime como `seed-mas-impulso.mjs`. Se corre:

```
node seed-mas-impulso.mjs <organization_id>
```

**Cómo aplicar**: ejecutar esto DENTRO del contenedor de producción ya
levantado (la terminal del servicio en EasyPanel) o vía un túnel puntual con
`DATABASE_URL` de producción que el dueño autorice explícitamente — ver
[produccion-easypanel-vocero](produccion-easypanel-vocero.md). Nunca correr
este seed contra la `DATABASE_URL` de producción desde este checkout local.
