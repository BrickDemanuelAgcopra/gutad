CREATE TABLE "item_location_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"price_cents" integer,
	"hidden" boolean DEFAULT false NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_location_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"document" jsonb NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"submitted_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"review_note" text,
	"published_at" timestamp with time zone,
	"published_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid,
	"channel" text,
	"previous_price_cents" integer,
	"new_price_cents" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"reason" text,
	"approval_id" uuid,
	"created_by_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid,
	"region" text,
	"category" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingredients" DROP CONSTRAINT "ingredients_name_unique";--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "packaging_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "allergens" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "serving_size" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "photos" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "nutrition" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "kind" text DEFAULT 'ITEM' NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "tax_category" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "max_per_order" integer;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "allergen_review_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "small_order_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "packaging_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "portion_size" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "substitutions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "equipment" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "prep_minutes" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "batch_max_portions" integer;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "status" text DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "trials" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "approved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "training_url" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "training_notes" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "change_summary" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "previous_recipe_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "small_order_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "packaging_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "platform_share_pct" integer;--> statement-breakpoint
ALTER TABLE "item_location_overrides" ADD CONSTRAINT "item_location_overrides_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_location_overrides" ADD CONSTRAINT "item_location_overrides_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_location_links" ADD CONSTRAINT "menu_location_links_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_location_links" ADD CONSTRAINT "menu_location_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_versions" ADD CONSTRAINT "menu_versions_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_acknowledgments" ADD CONSTRAINT "recipe_acknowledgments_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_acknowledgments" ADD CONSTRAINT "recipe_acknowledgments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_location_overrides_key" ON "item_location_overrides" USING btree ("menu_item_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_location_links_key" ON "menu_location_links" USING btree ("menu_id","location_id");--> statement-breakpoint
CREATE INDEX "menu_versions_menu_idx" ON "menu_versions" USING btree ("menu_id","version");--> statement-breakpoint
CREATE INDEX "price_changes_due_idx" ON "price_changes" USING btree ("status","effective_at");--> statement-breakpoint
CREATE INDEX "price_changes_item_idx" ON "price_changes" USING btree ("menu_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ack_key" ON "recipe_acknowledgments" USING btree ("recipe_id","user_id");--> statement-breakpoint
CREATE INDEX "tax_rates_lookup" ON "tax_rates" USING btree ("category","location_id","region");