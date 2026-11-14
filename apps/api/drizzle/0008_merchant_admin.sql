ALTER TYPE "public"."channel" ADD VALUE 'KIOSK';--> statement-breakpoint
CREATE TABLE "brand_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"location_id" uuid,
	"score" integer,
	"result" text NOT NULL,
	"notes" text,
	"reviewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"summary" text NOT NULL,
	"changes" jsonb NOT NULL,
	"before" jsonb,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_id" uuid,
	"author_role" text NOT NULL,
	"visibility" text DEFAULT 'PARTIES' NOT NULL,
	"body" text NOT NULL,
	"template_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text DEFAULT 'CLOSED' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"opens" text,
	"closes" text,
	"service" text DEFAULT 'ALL' NOT NULL,
	"reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_launch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_id" uuid,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"city" text,
	"cuisine" text,
	"locations_count" integer DEFAULT 1 NOT NULL,
	"website" text,
	"interest" text[] DEFAULT '{}' NOT NULL,
	"source" text DEFAULT 'WEB' NOT NULL,
	"stage" text DEFAULT 'LEAD' NOT NULL,
	"lost_reason" text,
	"owner_id" uuid,
	"organization_id" uuid,
	"est_monthly_orders" integer,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "owners" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "contacts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "account_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_location_states" jsonb;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "ownership_type" text DEFAULT 'INDEPENDENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "operating_rights" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "territory_region_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "contract_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "contract_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "rights_status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "rights_note" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "authorized_channels" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "royalty_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "presentation_standards" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "assets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "contacts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "accepts_kiosk" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "pickup_instructions" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "parking_info" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "courier_instructions" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "courier_point_lat" double precision;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "courier_point_lng" double precision;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "auto_accept" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "accept_timeout_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "ramp_throttle_per_15m" integer;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "ramp_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "readiness_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "readiness_approved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "max_concurrent" integer;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "is_available" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "equipment" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "reporter_type" text DEFAULT 'CUSTOMER' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD COLUMN "expiry_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_reviews" ADD CONSTRAINT "brand_reviews_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_closures" ADD CONSTRAINT "location_closures_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_launch_items" ADD CONSTRAINT "location_launch_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_reviews_brand_idx" ON "brand_reviews" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "change_requests_status_idx" ON "change_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "incident_messages_incident_idx" ON "incident_messages" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "location_closures_loc_idx" ON "location_closures" USING btree ("location_id","ends_at");--> statement-breakpoint
CREATE INDEX "location_launch_items_key" ON "location_launch_items" USING btree ("location_id","key");--> statement-breakpoint
CREATE INDEX "merchant_applications_stage_idx" ON "merchant_applications" USING btree ("stage","created_at");