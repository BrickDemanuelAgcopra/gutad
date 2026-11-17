CREATE TABLE "chef_calendar_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"open" boolean,
	"capacity" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kitchen_capacity_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"units" integer NOT NULL,
	"status" text DEFAULT 'HELD' NOT NULL,
	"hold_key" text,
	"quote_id" uuid,
	"order_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chef_calendar_days" ADD CONSTRAINT "chef_calendar_days_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_pauses" ADD CONSTRAINT "chef_pauses_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_capacity_ledger" ADD CONSTRAINT "kitchen_capacity_ledger_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_capacity_ledger" ADD CONSTRAINT "kitchen_capacity_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chef_calendar_days_uq" ON "chef_calendar_days" USING btree ("chef_profile_id","date");--> statement-breakpoint
CREATE INDEX "chef_pauses_chef_idx" ON "chef_pauses" USING btree ("chef_profile_id","start_date");--> statement-breakpoint
CREATE INDEX "kitchen_capacity_ledger_day_idx" ON "kitchen_capacity_ledger" USING btree ("location_id","service_date");--> statement-breakpoint
CREATE INDEX "kitchen_capacity_ledger_quote_idx" ON "kitchen_capacity_ledger" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "kitchen_capacity_ledger_order_idx" ON "kitchen_capacity_ledger" USING btree ("order_id");--> statement-breakpoint
-- existing scheduled orders at chef kitchens count against their service date
INSERT INTO "kitchen_capacity_ledger" ("location_id", "menu_item_id", "service_date", "units", "status", "order_id")
SELECT o."location_id", ol."menu_item_id", (o."scheduled_for" AT TIME ZONE l."timezone")::date, sum(ol."quantity")::int, 'CONFIRMED', o."id"
FROM "orders" o
JOIN "locations" l ON l."id" = o."location_id" AND l."chef_kitchen" = true
JOIN "order_lines" ol ON ol."order_id" = o."id"
WHERE o."scheduled_for" IS NOT NULL AND o."status" NOT IN ('CANCELED', 'REJECTED') AND ol."menu_item_id" IS NOT NULL
GROUP BY o."location_id", ol."menu_item_id", (o."scheduled_for" AT TIME ZONE l."timezone")::date, o."id";
