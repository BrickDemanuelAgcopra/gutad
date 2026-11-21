CREATE TABLE "courier_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'TRAINING' NOT NULL,
	"training_passed_at" timestamp with time zone,
	"certificate_file_url" text,
	"certificate_expires_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "driver_earnings_job_kind_uq";--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "special" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_certifications" ADD CONSTRAINT "courier_certifications_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_certifications_driver_category_uq" ON "courier_certifications" USING btree ("driver_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_earnings_job_kind_uq" ON "driver_earnings" USING btree ("delivery_job_id","kind") WHERE delivery_job_id is not null and kind in ('DELIVERY','CANCEL_COMP','SPECIAL');