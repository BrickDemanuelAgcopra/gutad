CREATE TABLE "message_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'GENERAL' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'MEDIUM' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"organization_id" uuid,
	"location_id" uuid,
	"dedupe_key" text,
	"owner_id" uuid,
	"owner_role" text DEFAULT 'OPERATIONS' NOT NULL,
	"escalate_at" timestamp with time zone,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text,
	"auto_resolved" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"author_id" uuid,
	"visibility" text DEFAULT 'INTERNAL' NOT NULL,
	"body" text NOT NULL,
	"template_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "partial_fulfillment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_alerts_status_idx" ON "ops_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ops_alerts_subject_idx" ON "ops_alerts" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_open_dedupe" ON "ops_alerts" USING btree ("dedupe_key") WHERE status <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "order_notes_order_idx" ON "order_notes" USING btree ("order_id","created_at");