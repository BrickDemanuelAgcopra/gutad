-- Organization feature flags become platform-staff overrides on top of the plan (Phase 2 of docs/PLANS-TRACKER.md).
-- The old values were provisioning defaults nobody enforced; clear them so they don't start blocking features.
UPDATE "organizations" SET "feature_flags" = '{}'::jsonb WHERE "feature_flags" <> '{}'::jsonb;
