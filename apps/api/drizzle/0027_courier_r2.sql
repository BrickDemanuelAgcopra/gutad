CREATE TABLE "courier_market_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region_id" uuid NOT NULL,
	"pay" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batching" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_market_policies_region_id_unique" UNIQUE("region_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "est_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "accepted_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "kitchen_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "provider_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "provider_cancel_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "provider_synced_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "detail" jsonb;--> statement-breakpoint
CREATE INDEX "delivery_jobs_hold_idx" ON "delivery_jobs" USING btree ("status","hold_until");