ALTER TYPE "public"."ledger_account" ADD VALUE 'GIFT_CARD_LIABILITY';--> statement-breakpoint
CREATE TABLE "campaign_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"grp" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"order_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"completed_at" timestamp with time zone,
	"credit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"goal_orders" integer NOT NULL,
	"window_days" integer NOT NULL,
	"min_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"location_ids" uuid[] DEFAULT '{}' NOT NULL,
	"reward_cents" integer NOT NULL,
	"reward_expires_days" integer DEFAULT 30 NOT NULL,
	"max_completions" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_card_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cents" integer NOT NULL,
	"order_id" uuid,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text DEFAULT 'PURCHASED' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"initial_cents" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"purchaser_id" uuid,
	"owner_id" uuid,
	"recipient_email" text,
	"recipient_name" text,
	"message" text,
	"payment_id" uuid,
	"issued_by_id" uuid,
	"reason" text,
	"locked_reason" text,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "offer_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"campaign_id" uuid,
	"order_id" uuid NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"discount_cents" integer NOT NULL,
	"platform_funded_cents" integer DEFAULT 0 NOT NULL,
	"merchant_funded_cents" integer DEFAULT 0 NOT NULL,
	"order_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"qualifying_order_id" uuid,
	"reward_points" integer DEFAULT 500 NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by_id" uuid,
	"review_note" text,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "holdout_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "segment_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "first_order_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "item_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "category_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "days_of_week" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "start_time" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "end_time" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "max_discount_cents" integer;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "stacking" text DEFAULT 'EXCLUSIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "payment_method_id" text;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD COLUMN "last_failure_reason" text;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "trial_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_assignments" ADD CONSTRAINT "campaign_assignments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_progress" ADD CONSTRAINT "challenge_progress_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_progress" ADD CONSTRAINT "challenge_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_txns" ADD CONSTRAINT "gift_card_txns_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_redemptions" ADD CONSTRAINT "offer_redemptions_promotion_id_coupons_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_users_id_fk" FOREIGN KEY ("referee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_assignments_key" ON "campaign_assignments" USING btree ("campaign_id","user_id");--> statement-breakpoint
CREATE INDEX "challenge_progress_user_idx" ON "challenge_progress" USING btree ("user_id","challenge_id");--> statement-breakpoint
CREATE INDEX "gift_card_txns_card_idx" ON "gift_card_txns" USING btree ("gift_card_id");--> statement-breakpoint
CREATE INDEX "gift_card_txns_order_idx" ON "gift_card_txns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "gift_cards_owner_idx" ON "gift_cards" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "gift_cards_purchaser_idx" ON "gift_cards" USING btree ("purchaser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_redemptions_promo_order_key" ON "offer_redemptions" USING btree ("promotion_id","order_id");--> statement-breakpoint
CREATE INDEX "offer_redemptions_user_idx" ON "offer_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referee_key" ON "referrals" USING btree ("referee_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;