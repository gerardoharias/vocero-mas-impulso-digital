-- 024: entrega y reintento íntegro de mensajes salientes (outbox sobre `message`).
-- Aditiva y re-ejecutable (Constitución IV): todo IF NOT EXISTS / DO-guard, sin backfill — los
-- DEFAULT (0, 'active', NULL) son el estado correcto de todo lo que ya existe. ADD COLUMN con DEFAULT
-- constante NOT NULL no reescribe la tabla en PostgreSQL >= 11 (metadatos únicamente).
-- lock_timeout: ALTER/CREATE INDEX piden un bloqueo sobre `message`/`offered_slot`; si una transacción larga
-- las tiene abiertas, sin tope harían cola y BLOQUEARÍAN la app detrás. Con el tope la migración falla
-- rápido y scripts/migrate.mjs reintenta (SET LOCAL sólo vive dentro de la transacción de drizzle).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "message_delivery_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"error_class" text,
	"meta_code" integer,
	"meta_subcode" integer,
	"http_status" integer,
	"wamid" text,
	"trace_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "error_code" integer;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "error_subcode" integer;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "error_class" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "trace_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "offer_state" text;--> statement-breakpoint
ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "message_id" text;--> statement-breakpoint
ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "shown" boolean DEFAULT true NOT NULL;--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_delivery_attempt_organization_id_organization_id_fk') THEN
		ALTER TABLE "message_delivery_attempt" ADD CONSTRAINT "message_delivery_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_delivery_attempt_message_id_message_id_fk') THEN
		ALTER TABLE "message_delivery_attempt" ADD CONSTRAINT "message_delivery_attempt_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offered_slot_message_id_message_id_fk') THEN
		ALTER TABLE "offered_slot" ADD CONSTRAINT "offered_slot_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_dedupe_key_unique') THEN
		ALTER TABLE "message" ADD CONSTRAINT "message_dedupe_key_unique" UNIQUE("dedupe_key");
	END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "message_delivery_attempt_msg_no_uq" ON "message_delivery_attempt" USING btree ("message_id","attempt_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_delivery_attempt_org_idx" ON "message_delivery_attempt" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_outbox_due_idx" ON "message" USING btree ("status","next_attempt_at") WHERE "message"."status" in ('queued','retrying','sending');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offered_slot_message_idx" ON "offered_slot" USING btree ("message_id");--> statement-breakpoint

-- G3 (spec 024): el payload de un saliente es inmutable. El código jamás cambia `text`; esto es la red de
-- seguridad para cualquier ruta futura. Sólo dispara con UPDATE OF text, así que el resto de los UPDATE
-- (estados, acuses, reintentos) no pagan nada.
CREATE OR REPLACE FUNCTION "message_out_text_immutable"() RETURNS trigger AS $$
BEGIN
	IF OLD."direction" = 'out' AND OLD."text" IS DISTINCT FROM NEW."text" THEN
		RAISE EXCEPTION 'message.text de un saliente es inmutable (spec 024, G3)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "message_out_text_immutable_trg" ON "message";--> statement-breakpoint
CREATE TRIGGER "message_out_text_immutable_trg" BEFORE UPDATE OF "text" ON "message" FOR EACH ROW EXECUTE FUNCTION "message_out_text_immutable"();
