CREATE TABLE "merchant_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_version" text NOT NULL,
	"contract_id" uuid,
	"accepted_by_id" uuid NOT NULL,
	"signature_name" text NOT NULL,
	"signature_title" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"doc_type" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"review_note" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"uploaded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "delivery_fleet_requested" "delivery_fleet";--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "delivery_fleet_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "delivery_fleet_request_note" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "platform_operated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_agreement_acceptances" ADD CONSTRAINT "merchant_agreement_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_agreement_acceptances" ADD CONSTRAINT "merchant_agreement_acceptances_contract_id_merchant_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."merchant_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_agreement_acceptances" ADD CONSTRAINT "merchant_agreement_acceptances_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_acceptances_org_idx" ON "merchant_agreement_acceptances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "merchant_documents_org_idx" ON "merchant_documents" USING btree ("organization_id");