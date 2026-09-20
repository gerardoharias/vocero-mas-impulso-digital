---
name: project-producto-revendible
description: Este repo no es una instancia de un solo cliente — es el producto white-label que Gerardo revende a varios clientes y prospectos; pendiente elegir el nombre de marca que reemplaza a "Vocero"
metadata:
  type: project
---

Confirmado por el dueño (2026-09-19): está renombrando **el producto que
revende**, no solo la instancia de MÁS Impulso Digital
([[project-mas-impulso-agenda-flag]]). El repo es la base comercial de una
agencia que despliega una instancia por cliente.

**Cómo aplica**: al tocar marca/branding, distinguir dos capas — (a) el nombre
comercial del producto (landing, propuesta, demo, `DEFAULT_BRANDING.name`), y
(b) el nombre que cada cliente pone en Ajustes → Marca, que es lo que ven sus
empleados. Un cambio de marca del producto debe tocar `DEFAULT_BRANDING` y la
compuerta `isVoceroName()` de `src/lib/brand.ts` (si no, el logo deja de
dibujarse en instancias recién instaladas), nunca asumir que basta con la
config por organización.

El repo es fork MIT de Kevin Belier: rebrandear y revender está permitido,
pero el `LICENSE` con el copyright original debe conservarse.
