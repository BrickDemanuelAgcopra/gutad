ALTER TYPE "public"."role" ADD VALUE 'CHEF';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'KITCHEN_ASSISTANT';--> statement-breakpoint
CREATE TABLE "chef_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_name" text,
	"region" text,
	"city" text,
	"kitchen_type" text,
	"percent_complete" integer DEFAULT 0 NOT NULL,
	"auto_check" jsonb,
	"reviewer_id" uuid,
	"correction_steps" text[] DEFAULT '{}' NOT NULL,
	"review_note" text,
	"decision_reason" text,
	"appeal_note" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organization_id" uuid,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_doc_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"regions" text[] DEFAULT '{}' NOT NULL,
	"kitchen_types" text[] DEFAULT '{}' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"needs_expiry" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"requirement_key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"expires_at" timestamp with time zone,
	"note" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chef_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"location_id" uuid,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"business_type" text DEFAULT 'INDIVIDUAL' NOT NULL,
	"bio" text,
	"portrait_file_id" uuid,
	"portfolio_file_ids" uuid[] DEFAULT '{}' NOT NULL,
	"cuisines" text[] DEFAULT '{}' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"experience_years" integer,
	"service_city" text,
	"service_region" text,
	"service_radius_km" integer,
	"kitchen_type" text,
	"operating" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" text,
	"accepting_orders" boolean DEFAULT false NOT NULL,
	"verified_credentials" text[] DEFAULT '{}' NOT NULL,
	"brand_agreement_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "chef_kitchen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chef_applications" ADD CONSTRAINT "chef_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_applications" ADD CONSTRAINT "chef_applications_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_applications" ADD CONSTRAINT "chef_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_documents" ADD CONSTRAINT "chef_documents_application_id_chef_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."chef_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_profiles" ADD CONSTRAINT "chef_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_profiles" ADD CONSTRAINT "chef_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_profiles" ADD CONSTRAINT "chef_profiles_application_id_chef_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."chef_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chef_profiles" ADD CONSTRAINT "chef_profiles_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chef_applications_user_uq" ON "chef_applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chef_applications_status_idx" ON "chef_applications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "chef_doc_requirements_key_uq" ON "chef_doc_requirements" USING btree ("key");--> statement-breakpoint
CREATE INDEX "chef_documents_app_idx" ON "chef_documents" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chef_profiles_org_uq" ON "chef_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chef_profiles_slug_uq" ON "chef_profiles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "chef_profiles_user_idx" ON "chef_profiles" USING btree ("user_id");--> statement-breakpoint
UPDATE "access_roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['chefs:view','chefs:export','chefs:create','chefs:edit','chefs:delete','chefs:approve'])) WHERE "kind" = 'SYSTEM' AND "key" IN ('OPERATIONS','CULINARY');--> statement-breakpoint
UPDATE "access_roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['chefs:view','chefs:export'])) WHERE "kind" = 'SYSTEM' AND "key" IN ('EXECUTIVE','SUPPORT');
--> statement-breakpoint
INSERT INTO "chef_doc_requirements" ("key","label","description","regions","kitchen_types","required","needs_expiry","sort_order") VALUES
('GOV_ID','Government photo ID','Driver license, passport or state ID of the chef','{}'::text[],'{}'::text[],true,true,1),
('FOOD_HANDLER','Food handler or food protection manager certificate','ServSafe, state food handler card or equivalent','{}'::text[],'{}'::text[],true,true,2),
('KITCHEN_PERMIT','Food establishment / kitchen permit','Health permit of the kitchen you cook in (yours or the operator’s)','{}'::text[],ARRAY['COMMERCIAL','SHARED_COMMISSARY','RESTAURANT']::text[],true,true,3),
('KITCHEN_USE_AGREEMENT','Kitchen use / rental agreement','Agreement with the commissary or restaurant that lets you produce there','{}'::text[],ARRAY['SHARED_COMMISSARY','RESTAURANT']::text[],true,false,4),
('HOME_KITCHEN_PERMIT','Cottage-food or home-kitchen operation permit','Only where your state or county allows selling meals from a home kitchen','{}'::text[],ARRAY['COTTAGE_HOME']::text[],true,true,5),
('INSPECTION_REPORT','Latest health inspection report','Most recent inspection of the kitchen','{}'::text[],'{}'::text[],false,false,6),
('LIABILITY_INSURANCE','General / product liability insurance','Certificate of insurance','{}'::text[],'{}'::text[],true,true,7),
('BUSINESS_REGISTRATION','Business registration','Articles of organization or business license, if you sell as a business','{}'::text[],'{}'::text[],false,false,8)
ON CONFLICT ("key") DO NOTHING;
