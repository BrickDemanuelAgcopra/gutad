CREATE TABLE "customer_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by_id" uuid,
	"appeal_status" text DEFAULT 'NONE' NOT NULL,
	"appeal_note" text,
	"appeal_decision_note" text,
	"appealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "payment_customer_ref" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "scheduled_slot_capacity" integer;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "schedule_lead_minutes" integer;--> statement-breakpoint
ALTER TABLE "data_requests" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_requests" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "data_requests" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "priority" text DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "queue" text DEFAULT 'SUPPORT' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "first_response_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolve_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "first_responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "sla_breached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "menu_item_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "responsibility_dispute" jsonb;--> statement-breakpoint
ALTER TABLE "customer_restrictions" ADD CONSTRAINT "customer_restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_restrictions_user_idx" ON "customer_restrictions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_methods_user_idx" ON "payment_methods" USING btree ("user_id");