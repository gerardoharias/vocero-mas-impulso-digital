# Parche de seguridad de Vocero raíz 2.5.3

Integrado el 2026-10-29 para `gerardoharias/vocero-mas-impulso-digital`.
Fuente: [release 2.5.3](https://github.com/kevinrivm/vocero-crm/releases/tag/v2.5.3),
tag `8b85439`, commit de seguridad
[`1c2b161`](https://github.com/kevinrivm/vocero-crm/commit/1c2b161be448a7b4876652eb3d6d3de446b3634c).

Es un backport del parche de seguridad. La versión propia sigue en 1.3.0:
no representa la incorporación de todas las funciones ni de las migraciones
de Vocero raíz hasta 2.5.3. Se conservan las personalizaciones del CRM.

## Cambios

| Componente | Antes | Después |
| --- | --- | --- |
| Next.js | 15.5.25 | 15.5.28 |
| sharp | 0.35.4 | 0.35.5 |
| Node en las tres etapas Docker y en CI | 22 flotante | 22.23.4 |
| drizzle-orm | 0.45.2 | 0.45.4 |
| drizzle-kit | 0.31.10 | 0.31.11 |
| Zod 4 transitivo de Better Auth | 4.4.3 | 4.6.7 |
| Configuración y plugin ESLint de Next | 15.5.25 / 15.5.20 | 15.5.28 |

Se regeneró `pnpm-lock.yaml`, conservando los overrides de seguridad propios.
Se comprobó su instalación congelada con pnpm 11.5.0, la versión declarada
por el proyecto. No hay migraciones ni variables nuevas para este parche.

## Alcance de seguridad

Según la release de origen, Next y sharp corrigen el RCE del optimizador de
imágenes SVG (GHSA-2464-fhr4-w9xw) y el DoS de Server Actions
(GHSA-p3m5-59mp-jv5r); Node corrige el decodificador Brotli y la tanda de
octubre; Drizzle corrige la inyección en identificadores; Zod 4 corrige
GHSA-mrhx-c7xc-m3w5 en la dependencia de Better Auth.

Esto no equivale a una auditoría sin alertas. `pnpm audit --prod` todavía
reporta 15 avisos (1 crítico, 5 altos, 5 moderados y 4 bajos), entre ellos:

- **Zod 3.25.76**, utilizado directamente por la app: permanece igual que
  en la release de origen. Sus esquemas no se migran a Zod 4 en este parche.
- **Better Auth 1.6.23**: avisos adicionales de OAuth, aprobación de dispositivos
  y rate limiting. La configuración actual usa email/password y organization;
  no configura proveedores sociales, OAuth Proxy ni autorización de dispositivos.
  Login y registro tienen además un limitador propio en `src/lib/auth/index.ts`.
  La actualización mayor de Better Auth requiere una revisión separada.
- **source-map-js**, vía PostCSS de Next: procesamiento de mapas de fuentes.
- **Vite y Vitest**: herramientas de desarrollo/pruebas que el auditor también
  enumera como transitivas por los peers opcionales de Better Auth.

## Verificación

Se usa Node 22.23.4 y pnpm 11.5.0. Las pruebas de integración y el self-test
apuntan a un Postgres temporal exclusivo, con credenciales ficticias y los
proveedores externos simulados; no usan la base ni las APIs de producción.

- `pnpm install --frozen-lockfile --offline`, typecheck y lint: correctos.
- `pnpm test`: 1,234 pruebas correctas en 103 archivos.
- `pnpm build`: correcto.
- `node scripts/ci-migrate-check.mjs`: 27 migraciones aplicadas de cero y
  repetidas correctamente, usando el directorio `drizzle/`.
- `pnpm test:integration`: 75 correctas y 64 fallidas. Se repitió la suite en
  una copia de `main` local (`ade34b3`) con su `package.json` y lockfile
  anteriores: mismo resultado y exactamente los mismos 64 nombres de pruebas
  fallidas. Incluyen expectativas anteriores del formato de hora y del flujo
  de envíos. No se modifican esas suites ni la lógica de agenda/envíos aquí.
- Imagen Docker construida desde cero con su instalación congelada de pnpm
  11.5.0: correcta. Node 22.23.4, Next 15.5.28 y sharp 0.35.5 comprobados
  dentro de la imagen final.
- Arranque del contenedor contra otra base temporal: migraciones y
  `/api/health` correctos (200); mocks de WhatsApp/IA bloqueados (404),
  conversaciones protegidas sin sesión (401).

El self-test E2E se registra al finalizar junto con el cambio en GitHub.

## Despliegue

EasyPanel construye `Dockerfile` desde `main` del repositorio, con
`autoDeploy: true`. Hace falta reconstruir la imagen completa para incorporar
Node; reiniciar el contenedor antiguo no aplica el parche. El servicio es
`automation/vocero`, en `https://vocero.tobaxis.com`.

El despliegue tiene `zeroDowntime: false`: reinicia la instancia. Después del
build, comprobar el commit efectivo en `inspectAppService` y la respuesta JSON
de `/api/health`. La versión 1.3.0 del healthcheck por sí sola no demuestra
que esté aplicado este backport.
