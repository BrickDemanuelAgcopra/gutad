// Follow-ups A: device fingerprints for duplicate-account detection (10.4-D).
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { users } from './accounts';

/**
 * 10.4-D A device an account signed in or registered from. The client sends a random id it generated and keeps
 * (X-Device-Id); only its SHA-256 is stored, so the raw value can't be replayed from the database.
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: text('device_hash').notNull(),
    /** web | ios | android | … (X-Client) */
    client: text('client'),
    userAgent: text('user_agent'),
    signIns: integer('sign_ins').notNull().default(1),
    firstSeenAt: createdAt(),
    lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_devices_user_device_key').on(t.userId, t.deviceHash), index('user_devices_hash_idx').on(t.deviceHash)],
);
