CREATE TYPE "public"."channel" AS ENUM('MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER', 'PHONE', 'WALK_IN', 'CAMPUS', 'CORPORATE', 'API');--> statement-breakpoint
CREATE TYPE "public"."delivery_fleet" AS ENUM('MERCHANT', 'PARTNER', 'PLATFORM');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('QUOTED', 'REQUESTED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'QUOTE_EXPIRED', 'UNASSIGNED', 'CANCELED', 'FAILED', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."event_inquiry_status" AS ENUM('INQUIRY', 'QUALIFIED', 'PROPOSED', 'CONTRACTED', 'DEPOSIT_PAID', 'CONFIRMED', 'HELD', 'COMPLETED', 'CANCELED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('PICKUP', 'DELIVERY', 'DINE_IN', 'SHIPMENT', 'CATERING');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('OPEN', 'INVESTIGATING', 'RESOLVED', 'APPEALED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."integration_type" AS ENUM('POS', 'PAYMENT', 'DELIVERY', 'MESSAGING', 'MAPS', 'PRINTER', 'TABLET', 'KDS', 'PARTNER_API');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('CUSTOMER_RECEIVABLE', 'PROCESSOR_CLEARING', 'MERCHANT_PAYABLE', 'DRIVER_PAYABLE', 'PROVIDER_PAYABLE', 'TAX_PAYABLE', 'PLATFORM_REVENUE_COMMISSION', 'PLATFORM_REVENUE_SUBSCRIPTION', 'PLATFORM_REVENUE_COVER_FEE', 'PLATFORM_REVENUE_SERVICE_FEE', 'PLATFORM_REVENUE_DELIVERY', 'PLATFORM_REVENUE_ADS', 'PLATFORM_REVENUE_MEMBERSHIP', 'PLATFORM_REVENUE_REFERRAL', 'PLATFORM_REVENUE_B2B', 'PLATFORM_REVENUE_FOOD_SALES', 'PLATFORM_EXPENSE_PROCESSING', 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', 'PLATFORM_EXPENSE_PROMOTION', 'PLATFORM_EXPENSE_REFUND', 'PLATFORM_EXPENSE_ROYALTY', 'PLATFORM_EXPENSE_COGS', 'CUSTOMER_CREDIT_LIABILITY', 'DEPOSIT_LIABILITY', 'BANK');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('PROSPECT', 'CLAIMED', 'VERIFIED', 'ONBOARDING', 'LIVE', 'PAUSED', 'SUSPENDED', 'OFFBOARDED');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL', 'SMS', 'PUSH', 'IN_APP');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('TRANSACTIONAL', 'MARKETING');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED', 'COMPLETED', 'REJECTED', 'CANCELED', 'PARTIALLY_FULFILLED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'SETTLED', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('ACCRUED', 'ELIGIBLE', 'SUBMITTED', 'PAID', 'RECONCILED', 'HELD', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."program_type" AS ENUM('CAMPUS', 'B2B_OPERATOR', 'CREATOR_BRAND');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'CONFIRMED', 'ARRIVED', 'SEATED', 'COMPLETED', 'EXPIRED', 'CANCELED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('CUSTOMER', 'MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST', 'KITCHEN', 'PACKER', 'DISPATCHER', 'DRIVER', 'SUPPORT', 'FINANCE', 'PLATFORM_ADMIN', 'ORG_MEMBER');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('RESERVED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'FAILED', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('WAITING', 'NOTIFIED', 'SEATED', 'EXPIRED', 'LEFT');--> statement-breakpoint
CREATE TABLE "account_recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "account_recovery_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"label" text,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"instructions" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"location_ids" uuid[] DEFAULT '{}' NOT NULL,
	"approval_limit_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'MERCHANT' NOT NULL,
	"tax_id" text,
	"billing_email" text,
	"status" "merchant_status" DEFAULT 'PROSPECT' NOT NULL,
	"feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"name" text,
	"roles" "role"[] DEFAULT '{"CUSTOMER"}' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"push_tokens" text[] DEFAULT '{}' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"dietary_notes" text,
	"is_guest" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_seller_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_url" text,
	"content_rights_ok" boolean DEFAULT true NOT NULL,
	"royalty_bps" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"is_online" boolean DEFAULT false NOT NULL,
	"fallback_owner" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "kitchens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text NOT NULL,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"postal_code" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"is_shared" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"tax_id" text,
	"country" text DEFAULT 'US' NOT NULL,
	"payout_provider" text DEFAULT 'mock' NOT NULL,
	"payout_account_id" text,
	"payout_onboarding_state" text DEFAULT 'NOT_STARTED' NOT NULL,
	"bank_last4" text,
	"beneficiary_name" text,
	"billing_contact" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_seller_id" uuid,
	"kitchen_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"cuisine" text[] DEFAULT '{}' NOT NULL,
	"phone" text,
	"email" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"hero_image_url" text,
	"photos" text[] DEFAULT '{}' NOT NULL,
	"amenities" text[] DEFAULT '{}' NOT NULL,
	"status" "merchant_status" DEFAULT 'CLAIMED' NOT NULL,
	"verified_at" timestamp with time zone,
	"claimed_by_user_id" uuid,
	"duplicate_of_id" uuid,
	"accepts_pickup" boolean DEFAULT true NOT NULL,
	"accepts_delivery" boolean DEFAULT false NOT NULL,
	"accepts_dine_in" boolean DEFAULT false NOT NULL,
	"accepts_reservations" boolean DEFAULT false NOT NULL,
	"accepts_events" boolean DEFAULT false NOT NULL,
	"accepts_catering" boolean DEFAULT false NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_until" timestamp with time zone,
	"order_throttle_per_15m" integer,
	"default_prep_minutes" integer DEFAULT 20 NOT NULL,
	"tax_rate_bps" integer DEFAULT 800 NOT NULL,
	"min_order_cents" integer DEFAULT 0 NOT NULL,
	"delivery_fleet" "delivery_fleet" DEFAULT 'PARTNER' NOT NULL,
	"delivery_radius_km" double precision DEFAULT 5 NOT NULL,
	"delivery_base_fee_cents" integer DEFAULT 399 NOT NULL,
	"delivery_per_km_cents" integer DEFAULT 50 NOT NULL,
	"rating" double precision,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"pos_provider" text,
	"pos_external_id" text,
	"tablet_fallback_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"opens" text NOT NULL,
	"closes" text NOT NULL,
	"service" text DEFAULT 'ALL' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" "channel" NOT NULL,
	"slug" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"partner_name" text,
	"partner_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "referral_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"referral_code" text NOT NULL,
	"partner_order_id" text,
	"converted_at" timestamp with time zone,
	"payable_cents" integer DEFAULT 0 NOT NULL,
	"agreement_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsored_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"campaign_id" uuid,
	"keyword" text,
	"city" text,
	"bid_cents" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredient_stock" (
	"kitchen_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"on_hand" double precision DEFAULT 0 NOT NULL,
	"par_level" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_stock_kitchen_id_ingredient_id_pk" PRIMARY KEY("kitchen_id","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"cost_cents_per_unit" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingredients_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "item_modifier_groups" (
	"item_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "item_modifier_groups_item_id_group_id_pk" PRIMARY KEY("item_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "labor_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"user_id" uuid,
	"hours" double precision NOT NULL,
	"rate_cents" integer NOT NULL,
	"date" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"image_url" text,
	"allergens" text[] DEFAULT '{}' NOT NULL,
	"dietary_tags" text[] DEFAULT '{}' NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL,
	"sold_out_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"pos_external_id" text,
	"channel_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"station_code" text,
	"recipe_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"brand_id" uuid,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"available_from" text,
	"available_until" text,
	"days_of_week" integer[] DEFAULT '{0,1,2,3,4,5,6}' NOT NULL,
	"channels" "channel"[] DEFAULT '{"MARKETPLACE","DIRECT","WIDGET","QR"}' NOT NULL,
	"pos_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL,
	"ingredient_id" uuid
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"received_qty" double precision
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"supplier" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"channel" "channel" NOT NULL,
	"fulfillment_type" "fulfillment_type" NOT NULL,
	"currency" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer NOT NULL,
	"service_fee_cents" integer DEFAULT 0 NOT NULL,
	"delivery_fee_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"promo_code" text,
	"promotion_funder" text,
	"delivery_quote_id" text,
	"delivery_provider_cost_cents" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"promise_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_consumed_by_order_id_unique" UNIQUE("consumed_by_order_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"yield_portions" double precision DEFAULT 1 NOT NULL,
	"labor_minutes" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waste_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" double precision NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kitchen_brands" (
	"kitchen_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "kitchen_brands_kitchen_id_brand_id_pk" PRIMARY KEY("kitchen_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "kitchen_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid,
	"station_code" text,
	"line_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"actor_role" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"brand_id" uuid,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"modifiers_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"special_instructions" text,
	"station_code" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"replacement_note" text,
	"participant_id" uuid,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"guest_name" text,
	"guest_email" text,
	"guest_phone" text,
	"channel" "channel" NOT NULL,
	"fulfillment_type" "fulfillment_type" NOT NULL,
	"status" "order_status" DEFAULT 'SUBMITTED' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer NOT NULL,
	"service_fee_cents" integer DEFAULT 0 NOT NULL,
	"delivery_fee_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"commission_bps" integer DEFAULT 0 NOT NULL,
	"contract_id" uuid,
	"promo_code" text,
	"promotion_funder" text,
	"price_snapshot" jsonb NOT NULL,
	"scheduled_for" timestamp with time zone,
	"promise_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"reject_reason" text,
	"pickup_code" text,
	"special_instructions" text,
	"delivery_address" jsonb,
	"pos_ticket_id" text,
	"external_order_id" text,
	"parent_order_id" uuid,
	"group_order_id" uuid,
	"campus_account_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "packing_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"bag_code" text NOT NULL,
	"status" text DEFAULT 'WAITING' NOT NULL,
	"verified_line_ids" uuid[] DEFAULT '{}' NOT NULL,
	"blocked_reason" text,
	"released_at" timestamp with time zone,
	CONSTRAINT "packing_tasks_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"location_id" uuid NOT NULL,
	"external_order_id" text,
	"fleet" "delivery_fleet" NOT NULL,
	"provider" text NOT NULL,
	"provider_quote_id" text,
	"provider_job_id" text,
	"status" "delivery_status" DEFAULT 'QUOTED' NOT NULL,
	"quote_expires_at" timestamp with time zone,
	"retail_fee_cents" integer DEFAULT 0 NOT NULL,
	"provider_cost_cents" integer DEFAULT 0 NOT NULL,
	"platform_subsidy_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"pickup_address" jsonb NOT NULL,
	"dropoff_address" jsonb NOT NULL,
	"driver_id" uuid,
	"eta_at" timestamp with time zone,
	"assigned_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"cost_owner" text,
	"proof_photo_url" text,
	"proof_signature" text,
	"tracking_url" text,
	"provider_invoice_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_jobs_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "delivery_jobs_provider_job_id_unique" UNIQUE("provider_job_id"),
	CONSTRAINT "delivery_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"polygon" jsonb,
	"fee_cents" integer NOT NULL,
	"min_order_cents" integer DEFAULT 0 NOT NULL,
	"eta_minutes" integer DEFAULT 40 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"delivery_job_id" uuid,
	"base_cents" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"bonus_cents" integer DEFAULT 0 NOT NULL,
	"payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"delivery_job_id" uuid NOT NULL,
	"pay_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'OFFERED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"vehicle" text,
	"license_verified" boolean DEFAULT false NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_seen_at" timestamp with time zone,
	"payout_provider" text DEFAULT 'mock' NOT NULL,
	"payout_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "blackout_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"reason" text,
	"closed" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"event_date" timestamp with time zone NOT NULL,
	"party_size" integer NOT NULL,
	"final_headcount" integer,
	"budget_cents" integer,
	"notes" text,
	"status" "event_inquiry_status" DEFAULT 'INQUIRY' NOT NULL,
	"proposal_cents" integer,
	"proposal_expires_at" timestamp with time zone,
	"contract_url" text,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"deposit_payment_id" uuid,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"balance_payment_id" uuid,
	"room_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_add_ons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experience_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid,
	"guest_name" text NOT NULL,
	"guest_email" text,
	"spots" integer NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'HELD' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"ticket_cents" integer NOT NULL,
	"service_fee_cents" integer DEFAULT 0 NOT NULL,
	"extras_onsite_cents" integer DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"attended_at" timestamp with time zone,
	"confirmation_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_tickets_confirmation_code_unique" UNIQUE("confirmation_code")
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"pricing_mode" text NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"service_fee_bps" integer DEFAULT 200 NOT NULL,
	"service_fee_payer" text DEFAULT 'DINER' NOT NULL,
	"refund_policy" text DEFAULT 'Refundable up to 48 hours before the session.' NOT NULL,
	"refund_cutoff_hours" integer DEFAULT 48 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"cancellation_hours" integer DEFAULT 2 NOT NULL,
	"requires_card_above" integer,
	"no_show_fee_cents" integer DEFAULT 0 NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"deposit_applies_to_check" boolean DEFAULT true NOT NULL,
	"hold_minutes" integer DEFAULT 10 NOT NULL,
	"reminder_hours_before" integer DEFAULT 24 NOT NULL,
	"large_party_threshold" integer DEFAULT 6 NOT NULL,
	CONSTRAINT "reservation_policies_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "reservation_tables" (
	"reservation_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	CONSTRAINT "reservation_tables_reservation_id_table_id_pk" PRIMARY KEY("reservation_id","table_id")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"guest_profile_id" uuid,
	"channel" "channel" NOT NULL,
	"status" "reservation_status" DEFAULT 'HELD' NOT NULL,
	"confirmation_code" text NOT NULL,
	"party_size" integer NOT NULL,
	"actual_party_size" integer,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"guest_name" text NOT NULL,
	"guest_phone" text,
	"guest_email" text,
	"notes" text,
	"occasion" text,
	"guarantee_payment_method_id" text,
	"deposit_payment_id" uuid,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"deposit_applied_cents" integer DEFAULT 0 NOT NULL,
	"no_show_charged_cents" integer DEFAULT 0 NOT NULL,
	"arrived_at" timestamp with time zone,
	"seated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"no_show_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"pos_check_id" text,
	"check_total_cents" integer,
	"billable_covers" integer,
	"cover_fee_cents" integer,
	"cover_invoice_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_confirmation_code_unique" UNIQUE("confirmation_code"),
	CONSTRAINT "reservations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days_of_week" integer[] DEFAULT '{0,1,2,3,4,5,6}' NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"slot_minutes" integer DEFAULT 15 NOT NULL,
	"turn_minutes_small" integer DEFAULT 75 NOT NULL,
	"turn_minutes_medium" integer DEFAULT 90 NOT NULL,
	"turn_minutes_large" integer DEFAULT 120 NOT NULL,
	"max_party_size" integer DEFAULT 8 NOT NULL,
	"max_covers_per_slot" integer DEFAULT 20 NOT NULL,
	"max_bookings_per_slot" integer DEFAULT 6 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_combinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_seats" integer NOT NULL,
	"max_seats" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_combo_members" (
	"combination_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	CONSTRAINT "table_combo_members_combination_id_table_id_pk" PRIMARY KEY("combination_id","table_id")
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"room_id" uuid,
	"name" text NOT NULL,
	"section" text,
	"min_seats" integer NOT NULL,
	"max_seats" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"pos_table_id" text
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"guest_name" text NOT NULL,
	"guest_phone" text,
	"party_size" integer NOT NULL,
	"status" "waitlist_status" DEFAULT 'WAITING' NOT NULL,
	"quoted_minutes" integer NOT NULL,
	"position" integer NOT NULL,
	"notified_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"seated_at" timestamp with time zone,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "b2b_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'PLACED' NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"campus_user_id" text NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"meal_swipes" integer DEFAULT 0 NOT NULL,
	"is_eligible" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus_locations" (
	"program_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "campus_locations_program_id_location_id_pk" PRIMARY KEY("program_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "corporate_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"per_person_cents" integer NOT NULL,
	"period_cents" integer,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_order_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_order_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"allowance_cents" integer,
	"overage_cents" integer DEFAULT 0 NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"late_join" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"location_id" uuid NOT NULL,
	"organizer_user_id" uuid NOT NULL,
	"budget_id" uuid,
	"mode" text NOT NULL,
	"name" text NOT NULL,
	"join_code" text NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"deliver_at" timestamp with time zone NOT NULL,
	"fulfillment_type" "fulfillment_type" DEFAULT 'DELIVERY' NOT NULL,
	"delivery_address" jsonb,
	"headcount" integer,
	"dietary_notes" text,
	"payer" text DEFAULT 'ORGANIZER' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"consolidated_order_id" uuid,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_orders_join_code_unique" UNIQUE("join_code")
);
--> statement-breakpoint
CREATE TABLE "meal_kit_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"price_cents" integer NOT NULL,
	"weight_grams" integer DEFAULT 0 NOT NULL,
	"ship_regions" text[] DEFAULT '{}' NOT NULL,
	"lead_days" integer DEFAULT 2 NOT NULL,
	"stock_on_hand" integer DEFAULT 0 NOT NULL,
	"stock_reserved" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "meal_kit_products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "packing_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_date" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"shipment_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "program_type" NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'APPLIED' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contract_ref" text,
	"compensation_bps" integer DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone,
	"offboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"line_id" uuid,
	"kind" text NOT NULL,
	"remedy" text,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"order_number" text NOT NULL,
	"status" "shipment_status" DEFAULT 'RESERVED' NOT NULL,
	"delivery_date" timestamp with time zone NOT NULL,
	"address" jsonb NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"batch_id" uuid,
	"total_cents" integer NOT NULL,
	"payment_id" uuid,
	"packed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"funder" text DEFAULT 'MERCHANT' NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"segment_id" uuid,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"attributed_revenue_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"funder" text DEFAULT 'MERCHANT' NOT NULL,
	"min_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"location_ids" uuid[] DEFAULT '{}' NOT NULL,
	"channels" "channel"[] DEFAULT '{}' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "guest_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"notes" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"lifetime_spend_cents" integer DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp with time zone,
	"favorites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contact_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "loyalty_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"cents" integer DEFAULT 0 NOT NULL,
	"funder" text DEFAULT 'PLATFORM' NOT NULL,
	"order_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"renewal_failures" integer DEFAULT 0 NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"interval" text NOT NULL,
	"benefits" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"recipient" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"kind" "notification_kind" DEFAULT 'TRANSACTIONAL' NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"rating" integer NOT NULL,
	"body" text,
	"verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"merchant_reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_locations" (
	"contract_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "contract_locations_contract_id_location_id_pk" PRIMARY KEY("contract_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "customer_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cents" integer NOT NULL,
	"reason" text NOT NULL,
	"funder" text DEFAULT 'PLATFORM' NOT NULL,
	"order_id" uuid,
	"expires_at" timestamp with time zone,
	"redeemed_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"provider_invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"organization_id" uuid,
	"location_id" uuid,
	"party_id" text,
	"order_id" uuid,
	"reservation_id" uuid,
	"payment_id" uuid,
	"refund_id" uuid,
	"payout_id" uuid,
	"invoice_id" uuid,
	"currency" text NOT NULL,
	"debit_cents" integer DEFAULT 0 NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"memo" text,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"plan_code" text NOT NULL,
	"billing_models" text[] DEFAULT '{}' NOT NULL,
	"subscription_cents" integer DEFAULT 0 NOT NULL,
	"subscription_interval" text DEFAULT 'MONTH' NOT NULL,
	"marketplace_commission_bps" integer DEFAULT 1500 NOT NULL,
	"direct_commission_bps" integer DEFAULT 0 NOT NULL,
	"processing_bps" integer DEFAULT 295 NOT NULL,
	"processing_fixed_cents" integer DEFAULT 29 NOT NULL,
	"cover_fee_network_cents" integer DEFAULT 150 NOT NULL,
	"cover_fee_direct_cents" integer DEFAULT 0 NOT NULL,
	"prepaid_service_fee_bps" integer DEFAULT 200 NOT NULL,
	"delivery_subsidy_cents" integer DEFAULT 0 NOT NULL,
	"logistics_fee_cents" integer DEFAULT 0 NOT NULL,
	"cancellation_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"region_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"gross_sales_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"tips_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"processing_cents" integer NOT NULL,
	"refunds_cents" integer NOT NULL,
	"adjustments_cents" integer DEFAULT 0 NOT NULL,
	"subscription_cents" integer DEFAULT 0 NOT NULL,
	"cover_fees_cents" integer DEFAULT 0 NOT NULL,
	"net_payable_cents" integer NOT NULL,
	"order_count" integer NOT NULL,
	"cover_count" integer DEFAULT 0 NOT NULL,
	"payout_id" uuid,
	"pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"user_id" uuid,
	"purpose" text DEFAULT 'ORDER' NOT NULL,
	"reference_id" text,
	"provider" text NOT NULL,
	"provider_intent_id" text,
	"provider_charge_id" text,
	"payment_method_id" text,
	"status" "payment_status" DEFAULT 'REQUIRES_ACTION' NOT NULL,
	"currency" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"authorized_cents" integer DEFAULT 0 NOT NULL,
	"captured_cents" integer DEFAULT 0 NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"processing_fee_cents" integer DEFAULT 0 NOT NULL,
	"application_fee_cents" integer DEFAULT 0 NOT NULL,
	"destination_account_id" text,
	"client_secret" text,
	"dispute_id" text,
	"dispute_status" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "payments_provider_intent_id_unique" UNIQUE("provider_intent_id"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"party_type" text NOT NULL,
	"party_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_transfer_id" text,
	"status" "payout_status" DEFAULT 'ACCRUED' NOT NULL,
	"currency" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"statement_id" uuid,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_provider_transfer_id_unique" UNIQUE("provider_transfer_id")
);
--> statement-breakpoint
CREATE TABLE "platform_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"location_count" integer DEFAULT 1 NOT NULL,
	"last_invoice_id" uuid,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_cents" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"matched_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_invoices_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"funder" text NOT NULL,
	"provider_refund_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approved_by_id" uuid,
	"incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_id" uuid,
	"approved_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"response_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"reservation_id" uuid,
	"delivery_job_id" uuid,
	"reporter_id" uuid,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"status" "incident_status" DEFAULT 'OPEN' NOT NULL,
	"owner" text,
	"remedy" text,
	"remedy_cents" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_id" uuid,
	"resolved_at" timestamp with time zone,
	"appeal_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"type" "integration_type" NOT NULL,
	"provider" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"webhook_secret" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"last_health_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"internal_id" text NOT NULL,
	"external_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_strikes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"closed_by_id" uuid,
	"orders_completed" integer DEFAULT 0 NOT NULL,
	"orders_canceled" integer DEFAULT 0 NOT NULL,
	"covers_seated" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"open_checks" integer DEFAULT 0 NOT NULL,
	"cash_cents" integer DEFAULT 0 NOT NULL,
	"waste_notes" text,
	"unresolved_incident_ids" uuid[] DEFAULT '{}' NOT NULL,
	"carried_forward" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_recovery_tokens" ADD CONSTRAINT "account_recovery_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_legal_seller_id_legal_sellers_id_fk" FOREIGN KEY ("legal_seller_id") REFERENCES "public"."legal_sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchens" ADD CONSTRAINT "kitchens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_sellers" ADD CONSTRAINT "legal_sellers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_legal_seller_id_legal_sellers_id_fk" FOREIGN KEY ("legal_seller_id") REFERENCES "public"."legal_sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_hours" ADD CONSTRAINT "opening_hours_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsored_placements" ADD CONSTRAINT "sponsored_placements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_stock" ADD CONSTRAINT "ingredient_stock_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_stock" ADD CONSTRAINT "ingredient_stock_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_entries" ADD CONSTRAINT "labor_entries_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_events" ADD CONSTRAINT "waste_events_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_events" ADD CONSTRAINT "waste_events_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_brands" ADD CONSTRAINT "kitchen_brands_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_brands" ADD CONSTRAINT "kitchen_brands_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_parent_order_id_orders_id_fk" FOREIGN KEY ("parent_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_tasks" ADD CONSTRAINT "packing_tasks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_job_id_delivery_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."delivery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_earnings" ADD CONSTRAINT "driver_earnings_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD CONSTRAINT "driver_offers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_offers" ADD CONSTRAINT "driver_offers_delivery_job_id_delivery_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."delivery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_inquiries" ADD CONSTRAINT "event_inquiries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_add_ons" ADD CONSTRAINT "experience_add_ons_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_sessions" ADD CONSTRAINT "experience_sessions_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_tickets" ADD CONSTRAINT "experience_tickets_session_id_experience_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."experience_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_events" ADD CONSTRAINT "reservation_events_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_policies" ADD CONSTRAINT "reservation_policies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combo_members" ADD CONSTRAINT "table_combo_members_combination_id_table_combinations_id_fk" FOREIGN KEY ("combination_id") REFERENCES "public"."table_combinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combo_members" ADD CONSTRAINT "table_combo_members_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_orders" ADD CONSTRAINT "b2b_orders_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_accounts" ADD CONSTRAINT "campus_accounts_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_accounts" ADD CONSTRAINT "campus_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_locations" ADD CONSTRAINT "campus_locations_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_locations" ADD CONSTRAINT "campus_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_budgets" ADD CONSTRAINT "corporate_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_order_participants" ADD CONSTRAINT "group_order_participants_group_order_id_group_orders_id_fk" FOREIGN KEY ("group_order_id") REFERENCES "public"."group_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_order_participants" ADD CONSTRAINT "group_order_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_orders" ADD CONSTRAINT "group_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_orders" ADD CONSTRAINT "group_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_orders" ADD CONSTRAINT "group_orders_budget_id_corporate_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."corporate_budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_kit_products" ADD CONSTRAINT "meal_kit_products_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_product_id_meal_kit_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."meal_kit_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_locations" ADD CONSTRAINT "contract_locations_contract_id_merchant_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."merchant_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_locations" ADD CONSTRAINT "contract_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_contracts" ADD CONSTRAINT "merchant_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_statements" ADD CONSTRAINT "merchant_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_contract_id_merchant_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."merchant_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_changes" ADD CONSTRAINT "config_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_integration_id_integration_accounts_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_summaries" ADD CONSTRAINT "shift_summaries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_user_purpose_idx" ON "consents" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "device_sessions_user_device_key" ON "device_sessions" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_memberships_user_org_role_key" ON "org_memberships" USING btree ("user_id","organization_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "locations_city_idx" ON "locations" USING btree ("city","region");--> statement-breakpoint
CREATE INDEX "locations_geo_idx" ON "locations" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX "quotes_location_created_idx" ON "quotes" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_location_status_idx" ON "orders" USING btree ("location_id","status","created_at");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_external_idx" ON "orders" USING btree ("external_order_id");--> statement-breakpoint
CREATE INDEX "reservations_location_start_idx" ON "reservations" USING btree ("location_id","start_at");--> statement-breakpoint
CREATE INDEX "reservations_user_idx" ON "reservations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "waitlist_location_status_idx" ON "waitlist_entries" USING btree ("location_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_accounts_program_user_key" ON "campus_accounts" USING btree ("program_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_profiles_org_email_key" ON "guest_profiles" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "guest_profiles_org_phone_idx" ON "guest_profiles" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_provider_event_key" ON "inbox_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "loyalty_user_idx" ON "loyalty_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_published_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "customer_credits_user_idx" ON "customer_credits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journal_batch_idx" ON "journal_entries" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "journal_account_party_idx" ON "journal_entries" USING btree ("account","party_id","created_at");--> statement-breakpoint
CREATE INDEX "journal_org_idx" ON "journal_entries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_org_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_mappings_key" ON "integration_mappings" USING btree ("integration_id","entity_type","external_id");