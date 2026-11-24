// Gutad first-party selling: versioned marketplace policy for Gutad's own locations (organization kind PLATFORM).
import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './_common';

/** Every saved version of the first-party marketplace policy; the highest version is in force. */
export const marketplacePolicyVersions = pgTable('marketplace_policy_versions', {
  id: id(),
  version: integer('version').notNull(),
  /** FirstPartyPolicy (@gutad/shared) */
  policy: jsonb('policy').notNull(),
  note: text('note'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('marketplace_policy_versions_version_uq').on(t.version)]);
