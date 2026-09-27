-- 023: estado técnico de fallos de IA por conversación (aislado del texto visible al cliente).
-- Aditiva y re-ejecutable (Constitución IV): sin backfill, el default 0 es el estado correcto de todo lo existente.
-- ADD COLUMN con DEFAULT constante NOT NULL no reescribe la tabla en PostgreSQL >= 11 (metadatos únicamente).
-- lock_timeout: el ALTER necesita ACCESS EXCLUSIVE; si una transacción larga tiene `conversation` abierta,
-- sin tope el ALTER haría cola y BLOQUEARÍA todas las consultas de la app detrás de él. Con el tope, la
-- migración falla rápido y scripts/migrate.mjs reintenta (SET LOCAL sólo vive dentro de la transacción de drizzle).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_kind" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_at" timestamp;
