ALTER TYPE "public"."role" ADD VALUE 'EXECUTIVE';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'OPERATIONS';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'CULINARY';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'MARKETING';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'IT';--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"organization_id" uuid,
	"read_only" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"ticket_ref" text,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"review_note" text,
	"action_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"summary" text NOT NULL,
	"organization_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"amount_cents" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by_id" uuid,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	"dedupe_key" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_scopes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"region_ids" uuid[] DEFAULT '{}' NOT NULL,
	"organization_ids" uuid[] DEFAULT '{}' NOT NULL,
	"location_ids" uuid[] DEFAULT '{}' NOT NULL,
	"max_sensitivity" text DEFAULT 'RESTRICTED' NOT NULL,
	"note" text,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amr" text[] DEFAULT '{}' NOT NULL,
	"client" text,
	"user_agent" text,
	"ip" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_recovery_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_scopes" ADD CONSTRAINT "staff_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "access_grants" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_subject_idx" ON "approval_requests" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_code_key" ON "regions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","created_at");