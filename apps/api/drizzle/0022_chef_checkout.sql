CREATE TABLE "checkout_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"guest_email" text,
	"status" text DEFAULT 'PAID' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total_cents" integer NOT NULL,
	"order_count" integer NOT NULL,
	"payment_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_groups_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "order_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_group_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "prepaid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accept_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "free_cancel_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "late_refund_pct" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recognized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_groups" ADD CONSTRAINT "checkout_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment_allocations" ADD CONSTRAINT "order_payment_allocations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_payment_allocations_payment_idx" ON "order_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "order_payment_allocations_order_idx" ON "order_payment_allocations" USING btree ("order_id");