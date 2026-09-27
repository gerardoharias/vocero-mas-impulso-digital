-- 026: memoria de aclaración de disponibilidad por conversación (mismo patrón que
-- `ai_fail_*` de 023/0022). Aditiva y re-ejecutable (Constitución IV): sin backfill,
-- el default 0/null es el estado correcto de toda fila existente ("sin aclaración pendiente").
-- ADD COLUMN con DEFAULT constante NOT NULL no reescribe la tabla en PostgreSQL >= 11.
-- lock_timeout: el ALTER necesita ACCESS EXCLUSIVE; sin tope, una transacción larga sobre
-- `conversation` haría cola al ALTER y bloquearía toda la app detrás de él. Con el tope, la
-- migración falla rápido y scripts/migrate.mjs reintenta (SET LOCAL sólo vive dentro de la
-- transacción de drizzle).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_kind" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_context" text;
