CREATE TABLE "chef_dish_extras" (
	"dish_id" uuid NOT NULL,
	"extra_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_extras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"synonyms" text[] DEFAULT '{}' NOT NULL,
	"portion_desc" text,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"max_qty" integer DEFAULT 2 NOT NULL,
	"prep_minutes_delta" integer DEFAULT 0 NOT NULL,
	"allergens" text[] DEFAULT '{}' NOT NULL,
	"removes_dietary_tags" text[] DEFAULT '{}' NOT NULL,
	"all_dishes" boolean DEFAULT false NOT NULL,
	"dish_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"review_note" text,
	"sold_out" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "selection_type" text DEFAULT 'CHOICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "parent_option_id" uuid;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "is_extras" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "max_qty" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "portion_desc" text;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "prep_minutes_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "adds_allergens" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "removes_dietary_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "search_terms" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "allergens" text[];--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "dietary_tags" text[];--> statement-breakpoint
ALTER TABLE "chef_dishes" ADD COLUMN "options_config" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chef_dishes" ADD COLUMN "modifier_group_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "chef_dish_extras" ADD CONSTRAINT "chef_dish_extras_dish_id_chef_dishes_id_fk" FOREIGN KEY ("dish_id") REFERENCES "public"."chef_dishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_dish_extras" ADD CONSTRAINT "chef_dish_extras_extra_id_chef_extras_id_fk" FOREIGN KEY ("extra_id") REFERENCES "public"."chef_extras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_extras" ADD CONSTRAINT "chef_extras_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chef_dish_extras_uq" ON "chef_dish_extras" USING btree ("dish_id","extra_id");--> statement-breakpoint
CREATE INDEX "chef_extras_chef_idx" ON "chef_extras" USING btree ("chef_profile_id");