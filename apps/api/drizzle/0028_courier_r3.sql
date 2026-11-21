ALTER TYPE "public"."ledger_account" ADD VALUE 'PLATFORM_EXPENSE_COURIER_INCENTIVE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'PLATFORM_EXPENSE_DELIVERY_VARIANCE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'PLATFORM_REVENUE_INSTANT_FEE';--> statement-breakpoint
CREATE TABLE "courier_campaign_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"payout_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"market_ids" uuid[] DEFAULT '{}' NOT NULL,
	"zone_ids" uuid[] DEFAULT '{}' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enrolment" text DEFAULT 'AUTO' NOT NULL,
	"budget_cents" integer NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"expected_jobs" real NOT NULL,
	"supply_couriers" real NOT NULL,
	"needed_couriers" integer NOT NULL,
	"actual_jobs" integer,
	"generated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_fraud_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"score" integer NOT NULL,
	"hold_active" boolean DEFAULT false NOT NULL,
	"decision" text,
	"reason" text,
	"notice" text,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"opened_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"type" text NOT NULL,
	"weight" integer NOT NULL,
	"delivery_job_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"case_id" uuid,
	"dedupe_key" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_risk_signals_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD COLUMN "recon_variance_cents" integer;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "kind" text DEFAULT 'SCHEDULED' NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_campaign_enrolments" ADD CONSTRAINT "courier_campaign_enrolments_campaign_id_courier_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."courier_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_campaign_enrolments" ADD CONSTRAINT "courier_campaign_enrolments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fraud_cases" ADD CONSTRAINT "courier_fraud_cases_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_risk_signals" ADD CONSTRAINT "courier_risk_signals_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_campaign_enrolments_uq" ON "courier_campaign_enrolments" USING btree ("campaign_id","driver_id");--> statement-breakpoint
CREATE INDEX "courier_campaigns_status_idx" ON "courier_campaigns" USING btree ("status","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_forecasts_zone_hour_uq" ON "courier_forecasts" USING btree ("zone_id","hour_start");--> statement-breakpoint
CREATE INDEX "courier_forecasts_hour_idx" ON "courier_forecasts" USING btree ("hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fraud_cases_open_uq" ON "courier_fraud_cases" USING btree ("driver_id") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX "courier_risk_signals_driver_idx" ON "courier_risk_signals" USING btree ("driver_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_earnings_job_campaign_uq" ON "driver_earnings" USING btree ("delivery_job_id","campaign_id") WHERE kind = 'INCENTIVE' and delivery_job_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_earnings_driver_campaign_uq" ON "driver_earnings" USING btree ("driver_id","campaign_id") WHERE kind = 'INCENTIVE' and delivery_job_id is null;