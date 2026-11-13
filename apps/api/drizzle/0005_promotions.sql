CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"redeemed_by_id" uuid,
	"periods_used" integer DEFAULT 0 NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"percent_off" integer DEFAULT 0 NOT NULL,
	"periods" integer DEFAULT 1 NOT NULL,
	"days" integer DEFAULT 0 NOT NULL,
	"plan_codes" text[] DEFAULT '{}' NOT NULL,
	"max_redemptions" integer,
	"new_merchants_only" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_redeemed_by_id_users_id_fk" FOREIGN KEY ("redeemed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_org_uq" ON "promotion_redemptions" USING btree ("promotion_id","organization_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_org_idx" ON "promotion_redemptions" USING btree ("organization_id");