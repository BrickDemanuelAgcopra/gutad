CREATE TABLE "checklist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"kitchen_id" uuid,
	"location_id" uuid,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missed_items" integer DEFAULT 0 NOT NULL,
	"signed_name" text NOT NULL,
	"completed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"frequency" text DEFAULT 'DAILY' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corrective_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid,
	"kitchen_id" uuid,
	"location_id" uuid,
	"title" text NOT NULL,
	"owner_id" uuid,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"evidence_url" text,
	"evidence_note" text,
	"completed_by_id" uuid,
	"completed_at" timestamp with time zone,
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"station_code" text,
	"manufacturer" text,
	"model" text,
	"serial" text,
	"is_automated" boolean DEFAULT false NOT NULL,
	"software_version" text,
	"status" text DEFAULT 'OK' NOT NULL,
	"service_interval_days" integer,
	"last_service_at" timestamp with time zone,
	"next_service_due_at" timestamp with time zone,
	"outage_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"equipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"fault_code" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"vendor" text,
	"opened_by_id" uuid,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid,
	"location_id" uuid,
	"kind" text NOT NULL,
	"inspector" text NOT NULL,
	"score" integer,
	"result" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_url" text,
	"inspected_at" timestamp with time zone NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"severity" text DEFAULT 'HIGH' NOT NULL,
	"ingredient_id" uuid,
	"supplier_id" uuid,
	"lot_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"affected_menu_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"affected_order_count" integer DEFAULT 0 NOT NULL,
	"customers_notified_at" timestamp with time zone,
	"created_by_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"kitchen_id" uuid,
	"station_code" text,
	"user_id" uuid NOT NULL,
	"role" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_skills" (
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"certified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"trained_by_id" uuid,
	CONSTRAINT "staff_skills_user_id_organization_id_skill_pk" PRIMARY KEY("user_id","organization_id","skill")
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"storage_area_id" uuid,
	"supplier_id" uuid,
	"purchase_order_id" uuid,
	"transfer_id" uuid,
	"lot_code" text NOT NULL,
	"received_qty" double precision NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"lot_id" uuid,
	"kind" text NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_cost_cents" integer,
	"reason" text,
	"order_id" uuid,
	"reference_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_kitchen_id" uuid NOT NULL,
	"to_kitchen_id" uuid NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" uuid,
	"picked_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"received_by_id" uuid,
	"discrepancy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'DRY' NOT NULL,
	"min_temp_c" double precision,
	"max_temp_c" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"lead_time_days" integer DEFAULT 2 NOT NULL,
	"delivery_days" integer[] DEFAULT '{}' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temperature_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"storage_area_id" uuid,
	"purchase_order_id" uuid,
	"lot_id" uuid,
	"kind" text NOT NULL,
	"temp_c" double precision NOT NULL,
	"min_c" double precision,
	"max_c" double precision,
	"in_range" boolean NOT NULL,
	"note" text,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kitchen_id" uuid,
	"shift_id" uuid,
	"clock_in_at" timestamp with time zone NOT NULL,
	"clock_out_at" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"rate_cents" integer DEFAULT 0 NOT NULL,
	"approved_by_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "offline_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingredient_stock" ADD COLUMN "safety_stock" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "kind" text DEFAULT 'INGREDIENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "purchase_unit_factor" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "shelf_life_days" integer;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "min_temp_c" double precision;--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "max_temp_c" double precision;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "sold_out_source" text;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "discrepancy_note" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "expected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "invoice_total_cents" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "invoice_lines" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "match_status" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "match_detail" jsonb;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "required_skill" text;--> statement-breakpoint
CREATE INDEX "staff_shifts_loc_idx" ON "staff_shifts" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "stock_lots_kitchen_ing_idx" ON "stock_lots" USING btree ("kitchen_id","ingredient_id","expires_at");--> statement-breakpoint
CREATE INDEX "stock_movements_kitchen_idx" ON "stock_movements" USING btree ("kitchen_id","ingredient_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_lot_idx" ON "stock_movements" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "stock_movements_order_idx" ON "stock_movements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "temperature_logs_kitchen_idx" ON "temperature_logs" USING btree ("kitchen_id","created_at");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id","clock_in_at");--> statement-breakpoint
CREATE INDEX "time_entries_loc_idx" ON "time_entries" USING btree ("location_id","clock_in_at");