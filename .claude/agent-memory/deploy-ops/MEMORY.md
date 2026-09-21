<!--
Índice de memoria del subagente deploy-ops (memoria de proyecto, versionada).
Una línea por memoria: - [Título](archivo.md) — gancho de una línea.
Vacío al inicio; el subagente lo irá poblando (IDs de la plataforma, modos de
fallo recurrentes del deploy, comando de migración, healthcheck, etc.).
-->

- [Producción vive en EasyPanel](produccion-easypanel-vocero.md) — proyecto `automation`, servicio `vocero`, dominio `vocero.tobaxis.com`; se despliega e inspecciona con el MCP `easypanel-tobaxis`.
- [Seed de MÁS Impulso Digital en producción](mas-impulso-seed-produccion.md) — correr `node seed-mas-impulso.mjs <org_id>` dentro del contenedor, nunca desde dev.
