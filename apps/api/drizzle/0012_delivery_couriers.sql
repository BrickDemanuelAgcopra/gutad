CREATE TABLE "courier_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_url" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"severity" integer,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"zone_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid,
	"location_id" uuid,
	"region_id" uuid,
	"kind" text NOT NULL,
	"value" integer,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region_id" uuid,
	"provider" text NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "delivery_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "delivery_window_capacity" integer;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "proof_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "arrived_pickup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "arrived_dropoff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "offer_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "requirements" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "exception" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "provider_chain" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "zone_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "distance_km" double precision;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "kind" text DEFAULT 'SERVICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "location_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "travel_minutes_per_km" double precision;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "capacity_per_hour" integer;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "hours" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "fee_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "kind" text DEFAULT 'DELIVERY' NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD COLUMN "score" double precision;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD COLUMN "score_detail" jsonb;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "vehicle_type" text DEFAULT 'BIKE' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "zone_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "max_concurrent" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "suspended_by_id" uuid;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "appeal_status" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "appeal_note" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "appeal_decision_note" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "courier_documents" ADD CONSTRAINT "courier_documents_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_records" ADD CONSTRAINT "courier_records_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_shifts" ADD CONSTRAINT "courier_shifts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courier_documents_driver_idx" ON "courier_documents" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "courier_shifts_driver_idx" ON "courier_shifts" USING btree ("driver_id","starts_at");--> statement-breakpoint
CREATE INDEX "delivery_restrictions_ends_idx" ON "delivery_restrictions" USING btree ("ends_at");