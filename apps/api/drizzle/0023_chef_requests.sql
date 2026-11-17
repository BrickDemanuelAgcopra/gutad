CREATE TABLE "chef_request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" uuid,
	"author_role" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_request_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text DEFAULT 'QUOTE' NOT NULL,
	"status" text DEFAULT 'SENT' NOT NULL,
	"chef_dish_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"option_ids" uuid[] DEFAULT '{}' NOT NULL,
	"changes" text NOT NULL,
	"portion_desc" text DEFAULT '' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"allergens" text[] DEFAULT '{}' NOT NULL,
	"dietary_tags" text[] DEFAULT '{}' NOT NULL,
	"prep_minutes" integer,
	"service_date" date NOT NULL,
	"service_time" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"order_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chef_profile_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"chef_dish_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"details" text NOT NULL,
	"ingredient" text,
	"servings" integer DEFAULT 1 NOT NULL,
	"requested_date" date NOT NULL,
	"requested_time" text,
	"reason" text DEFAULT 'PREFERENCE' NOT NULL,
	"budget_cents" integer,
	"alternatives_ok" boolean DEFAULT true NOT NULL,
	"alternatives_note" text,
	"base_option_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"respond_by" timestamp with time zone,
	"current_quote_id" uuid,
	"order_id" uuid,
	"first_response_at" timestamp with time zone,
	"closed_reason" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chef_request_messages" ADD CONSTRAINT "chef_request_messages_request_id_chef_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."chef_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_request_quotes" ADD CONSTRAINT "chef_request_quotes_request_id_chef_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."chef_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_request_quotes" ADD CONSTRAINT "chef_request_quotes_chef_dish_id_chef_dishes_id_fk" FOREIGN KEY ("chef_dish_id") REFERENCES "public"."chef_dishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_request_quotes" ADD CONSTRAINT "chef_request_quotes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_request_quotes" ADD CONSTRAINT "chef_request_quotes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD CONSTRAINT "chef_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD CONSTRAINT "chef_requests_chef_profile_id_chef_profiles_id_fk" FOREIGN KEY ("chef_profile_id") REFERENCES "public"."chef_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD CONSTRAINT "chef_requests_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD CONSTRAINT "chef_requests_chef_dish_id_chef_dishes_id_fk" FOREIGN KEY ("chef_dish_id") REFERENCES "public"."chef_dishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_requests" ADD CONSTRAINT "chef_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chef_request_messages_req_idx" ON "chef_request_messages" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chef_request_quotes_version_uq" ON "chef_request_quotes" USING btree ("request_id","version");--> statement-breakpoint
CREATE INDEX "chef_request_quotes_status_idx" ON "chef_request_quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "chef_requests_user_idx" ON "chef_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chef_requests_chef_idx" ON "chef_requests" USING btree ("chef_profile_id","status");--> statement-breakpoint
CREATE INDEX "chef_requests_status_idx" ON "chef_requests" USING btree ("status","respond_by");