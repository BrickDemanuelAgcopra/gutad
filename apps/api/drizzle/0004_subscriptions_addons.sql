CREATE TABLE "add_ons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"product_line" text DEFAULT 'ALL' NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"interval" text DEFAULT 'MONTH' NOT NULL,
	"per_location" boolean DEFAULT false NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "add_ons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "org_add_ons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"add_on_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"price_cents" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "org_add_ons" ADD CONSTRAINT "org_add_ons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_add_ons" ADD CONSTRAINT "org_add_ons_add_on_id_add_ons_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_ons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_add_ons" ADD CONSTRAINT "org_add_ons_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_add_ons_org_idx" ON "org_add_ons" USING btree ("organization_id","status");