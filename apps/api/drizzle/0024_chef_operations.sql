CREATE TABLE "chef_quality_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'STAFF' NOT NULL,
	"incident_id" uuid,
	"chef_dish_id" uuid,
	"data" jsonb,
	"note" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chef_profiles" ADD COLUMN "status_cause" text;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chef_quality_events" ADD CONSTRAINT "chef_quality_events_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chef_quality_events_chef_idx" ON "chef_quality_events" USING btree ("chef_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chef_quality_events_incident_uq" ON "chef_quality_events" USING btree ("incident_id","kind");