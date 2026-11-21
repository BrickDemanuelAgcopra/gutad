CREATE TABLE "courier_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"check" text NOT NULL,
	"status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"provider" text,
	"provider_ref" text,
	"note" text,
	"expires_at" timestamp with time zone,
	"decided_by_id" uuid,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text,
	"shift_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_job_id" uuid NOT NULL,
	"order_id" uuid,
	"customer_id" uuid NOT NULL,
	"driver_id" uuid,
	"rating" integer NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"comment" text,
	"food_rating" integer,
	"packaging_rating" integer,
	"issues" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'VISIBLE' NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"excluded_reason" text,
	"dispute_status" text DEFAULT 'NONE' NOT NULL,
	"dispute_note" text,
	"incident_ids" uuid[] DEFAULT '{}' NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wait_minutes" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "handoff_pin" text;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "pickup_check" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "custody" text DEFAULT 'KITCHEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "pay_policy" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "handoff_method" text;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "id_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "distance_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "time_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "waiting_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "return_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "policy_version" integer;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD COLUMN "pay_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "application_status" text DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "lifecycle_status" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "decided_by_id" uuid;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "lifecycle_reason" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "availability_mode" text DEFAULT 'ON_DEMAND' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "on_break" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "finish_after_current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "first_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "rating_avg" double precision;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_shifts" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "courier_eligibility" ADD CONSTRAINT "courier_eligibility_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_time_entries" ADD CONSTRAINT "courier_time_entries_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_eligibility_driver_check_uq" ON "courier_eligibility" USING btree ("driver_id","check");--> statement-breakpoint
CREATE INDEX "courier_time_driver_idx" ON "courier_time_entries" USING btree ("driver_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_reviews_job_customer_uq" ON "delivery_reviews" USING btree ("delivery_job_id","customer_id");--> statement-breakpoint
CREATE INDEX "delivery_reviews_driver_idx" ON "delivery_reviews" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_earnings_job_kind_uq" ON "driver_earnings" USING btree ("delivery_job_id","kind") WHERE delivery_job_id is not null and kind in ('DELIVERY','CANCEL_COMP');--> statement-breakpoint
-- Courier R1 backfill: couriers approved before R1 keep working (application APPROVED, lifecycle from status, checks PASSED)
UPDATE "drivers" SET "application_status" = CASE WHEN "status" = 'PENDING' THEN 'VERIFICATION_PENDING' ELSE 'APPROVED' END,
  "lifecycle_status" = CASE WHEN "status" = 'APPROVED' THEN 'ACTIVE' WHEN "status" = 'SUSPENDED' THEN 'SUSPENDED' ELSE NULL END,
  "submitted_at" = "created_at";--> statement-breakpoint
INSERT INTO "courier_eligibility" ("driver_id", "check", "status", "note")
  SELECT d."id", c."check", 'PASSED', 'Approved before Courier R1' FROM "drivers" d
  CROSS JOIN (VALUES ('IDENTITY'), ('VEHICLE'), ('SCREENING'), ('PAYOUT'), ('AGREEMENT'), ('TRAINING'), ('EQUIPMENT')) AS c("check")
  WHERE d."application_status" = 'APPROVED'
  ON CONFLICT DO NOTHING;
