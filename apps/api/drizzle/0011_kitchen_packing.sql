CREATE TABLE "kitchen_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid,
	"station_code" text,
	"kind" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"match_type" text NOT NULL,
	"match_id" uuid NOT NULL,
	"station_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchens" ADD COLUMN "default_station_code" text;--> statement-breakpoint
ALTER TABLE "kitchens" ADD COLUMN "auto_throttle" jsonb;--> statement-breakpoint
ALTER TABLE "kitchens" ADD COLUMN "load_level" text DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchens" ADD COLUMN "load_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "pickup_shelves" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "packing_extras" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "require_pack_verification" boolean;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "cook_minutes" integer;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "handling" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "kind" text DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "fire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "ready_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "cook_minutes" integer;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "delayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "handling" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "table_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "utensils" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shelf_slot" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handoff" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "no_show_stage" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "no_show_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "checklist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "bag_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "bags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "handling" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "verified_by_id" uuid;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "target_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_events" ADD CONSTRAINT "kitchen_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_routes" ADD CONSTRAINT "station_routes_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_events_loc_idx" ON "kitchen_events" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "station_routes_kitchen_idx" ON "station_routes" USING btree ("kitchen_id");