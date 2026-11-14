ALTER TYPE "public"."ledger_account" ADD VALUE 'DISPUTE_RECEIVABLE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'DEFERRED_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'PLATFORM_REVENUE_BREAKAGE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'SUPPLIER_PAYABLE';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'INVENTORY';--> statement-breakpoint
ALTER TYPE "public"."ledger_account" ADD VALUE 'PLATFORM_ADJUSTMENTS';--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cost_center" text NOT NULL,
	"period" text NOT NULL,
	"category" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "close_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_by_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid,
	"organization_id" uuid,
	"provider_dispute_id" text NOT NULL,
	"reason" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'NEEDS_RESPONSE' NOT NULL,
	"evidence_due_at" timestamp with time zone,
	"evidence" jsonb,
	"evidence_submitted_at" timestamp with time zone,
	"liability" text DEFAULT 'PLATFORM' NOT NULL,
	"outcome_at" timestamp with time zone,
	"outcome_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity" text DEFAULT 'GUTAD' NOT NULL,
	"ledger_account" text NOT NULL,
	"gl_code" text NOT NULL,
	"gl_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"payment_id" uuid,
	"order_id" uuid,
	"quote_id" uuid,
	"user_id" uuid,
	"location_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"party_type" text,
	"payout_count" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"approval_id" uuid,
	"approved_by_id" uuid,
	"submitted_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"raised_by_id" uuid,
	"reason" text NOT NULL,
	"amount_cents" integer,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution" text,
	"adjustment_cents" integer,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_sellers" ADD COLUMN "payout_hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "bill_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "bill_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "split" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_failure_reason" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "allocation" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_key" ON "budgets" USING btree ("cost_center","period","category");--> statement-breakpoint
CREATE UNIQUE INDEX "close_periods_period" ON "close_periods" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_provider_key" ON "disputes" USING btree ("provider_dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_entity_account" ON "gl_accounts" USING btree ("legal_entity","ledger_account");--> statement-breakpoint
CREATE INDEX "payment_failures_created_idx" ON "payment_failures" USING btree ("created_at");