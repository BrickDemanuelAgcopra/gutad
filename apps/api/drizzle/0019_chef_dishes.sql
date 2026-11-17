CREATE TABLE "chef_dishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"dish_name" text NOT NULL,
	"description" text,
	"cuisine" text,
	"portion_desc" text DEFAULT '' NOT NULL,
	"ingredients" text[] DEFAULT '{}' NOT NULL,
	"allergens_confirmed" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'FIXED' NOT NULL,
	"accepts_special_requests" boolean DEFAULT false NOT NULL,
	"fulfillment_format" text DEFAULT 'HOT' NOT NULL,
	"prep_minutes" integer DEFAULT 45 NOT NULL,
	"daily_capacity" integer,
	"min_lead_days" integer,
	"cutoff_hour" integer,
	"max_advance_days" integer,
	"photos" text[] DEFAULT '{}' NOT NULL,
	"review_status" text DEFAULT 'DRAFT' NOT NULL,
	"review_note" text,
	"pending_changes" jsonb,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chef_dishes" ADD CONSTRAINT "chef_dishes_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_dishes" ADD CONSTRAINT "chef_dishes_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_dishes" ADD CONSTRAINT "chef_dishes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chef_dishes_item_uq" ON "chef_dishes" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "chef_dishes_chef_idx" ON "chef_dishes" USING btree ("chef_profile_id");--> statement-breakpoint
CREATE INDEX "chef_dishes_status_idx" ON "chef_dishes" USING btree ("review_status");