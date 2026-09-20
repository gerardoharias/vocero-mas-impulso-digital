# Memoria — Vocero CRM (MÁS Impulso Digital)

- [MÁS Impulso Digital + bandera AGENDA](project-mas-impulso-agenda-flag.md) — Citas/Agenda ya construido, apagado por AGENDA=off en deploy
- [Auditar antes de construir](feedback-audit-before-build.md) — verificar specs/código/banderas antes de asumir que algo falta
- [Triaje de Dependabot](feedback-dependabot-triage.md) — priorizar por exposición real, no por severity crudo de GitHub
- [Diagnóstico "bot no responde"](feedback-bot-no-responde-diagnostico.md) — revisar direction/origin en BD antes de sospechar del pipeline: puede ser mix-up de probar con el CRM abierto
- [El repo es producto revendible](project-producto-revendible.md) — marca de producto vs. marca por cliente; rename toca DEFAULT_BRANDING + isVoceroName
- [Entorno del self-test local](project-entorno-selftest-local.md) — postgres en 5433, app en 3100, GOOGLE_*_BASE_URL del mock; un check del QA ya falla en main
