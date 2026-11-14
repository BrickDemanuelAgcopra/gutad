CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_hash" text NOT NULL,
	"client" text,
	"user_agent" text,
	"sign_ins" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_load_settings" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"busy_at_open_orders" integer DEFAULT 8 NOT NULL,
	"overload_at_open_orders" integer DEFAULT 14 NOT NULL,
	"busy_at_backlog_minutes" integer,
	"overload_at_backlog_minutes" integer,
	"parallel_orders" integer DEFAULT 3 NOT NULL,
	"busy_extra_minutes" integer DEFAULT 10 NOT NULL,
	"last_level" text DEFAULT 'NORMAL' NOT NULL,
	"last_changed_at" timestamp with time zone,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"printer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid,
	"order_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"requested_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"station_code" text,
	"role" text DEFAULT 'TICKETS' NOT NULL,
	"protocol" text DEFAULT 'LOG' NOT NULL,
	"host" text,
	"port" integer DEFAULT 9100 NOT NULL,
	"width" integer DEFAULT 42 NOT NULL,
	"auto_print" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"last_error" text,
	"last_printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"owner_user_id" uuid,
	"driver_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_vendor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"equipment_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"kind" text NOT NULL,
	"external_event_id" text,
	"code" text,
	"severity" text,
	"message" text,
	"metrics" jsonb,
	"alerted" boolean DEFAULT false NOT NULL,
	"ticket_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_vendor_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"equipment_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"external_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"poll_enabled" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_status" jsonb,
	"last_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity" text DEFAULT 'GUTAD' NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'CONNECTED' NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_tenant_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by_id" uuid,
	"last_push_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_push_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"legal_entity" text NOT NULL,
	"provider" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_id" text,
	"lines" integer DEFAULT 0 NOT NULL,
	"debit_cents" integer DEFAULT 0 NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"unmapped" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'CONNECTED' NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_company_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"external_id" text,
	"employees" integer DEFAULT 0 NOT NULL,
	"regular_hours" double precision DEFAULT 0 NOT NULL,
	"overtime_hours" double precision DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"unapproved_hours" double precision DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"pushed_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"organization_id" uuid,
	"label" text,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"token_id" uuid,
	"purchase_order_id" uuid,
	"source" text NOT NULL,
	"invoice_number" text,
	"status" text NOT NULL,
	"total_cents" integer,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temperature_sensors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"storage_area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"serial" text,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"is_online" boolean DEFAULT false NOT NULL,
	"last_reading_at" timestamp with time zone,
	"last_temp_c" double precision,
	"last_in_range" boolean,
	"last_logged_at" timestamp with time zone,
	"battery_pct" integer,
	"offline_after_minutes" integer,
	"offline_alerted_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "buy_qty" integer;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "get_qty" integer;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "pending_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_restrictions" ADD COLUMN "limit_cents" integer;--> statement-breakpoint
ALTER TABLE "customer_restrictions" ADD COLUMN "period_days" integer;--> statement-breakpoint
ALTER TABLE "courier_documents" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "close_periods" ADD COLUMN "reopened_by_id" uuid;--> statement-breakpoint
ALTER TABLE "close_periods" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "close_periods" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_load_settings" ADD CONSTRAINT "location_load_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_device_key" ON "user_devices" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE INDEX "user_devices_hash_idx" ON "user_devices" USING btree ("device_hash");--> statement-breakpoint
CREATE INDEX "print_jobs_status_idx" ON "print_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "print_jobs_location_idx" ON "print_jobs" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "printers_location_idx" ON "printers" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "stored_files_owner_idx" ON "stored_files" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "equipment_vendor_events_eq_idx" ON "equipment_vendor_events" USING btree ("equipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_vendor_events_ext" ON "equipment_vendor_events" USING btree ("link_id","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_vendor_links_equipment" ON "equipment_vendor_links" USING btree ("equipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_vendor_links_token" ON "equipment_vendor_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_connections_entity" ON "gl_connections" USING btree ("legal_entity");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_push_batches_key" ON "gl_push_batches" USING btree ("legal_entity","provider","period");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_connections_org" ON "payroll_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_export_batches_key" ON "payroll_export_batches" USING btree ("location_id","provider","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_access_tokens_hash" ON "supplier_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "supplier_access_tokens_supplier_idx" ON "supplier_access_tokens" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_submissions_supplier_idx" ON "supplier_invoice_submissions" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "temperature_sensors_token" ON "temperature_sensors" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "temperature_sensors_kitchen_idx" ON "temperature_sensors" USING btree ("kitchen_id");