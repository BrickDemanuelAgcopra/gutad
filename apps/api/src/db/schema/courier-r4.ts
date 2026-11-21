// Courier Release 4: specialised categories — category certifications.
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { drivers } from './delivery';

/** One row per courier and category (ALCOHOL | CATERING | SENSITIVE | TEMP_CONTROLLED). */
export const courierCertifications = pgTable('courier_certifications', {
  id: id(),
  driverId: uuid('driver_id').notNull().references(() => drivers.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  /** TRAINING | PENDING | ACTIVE | REJECTED | EXPIRED | REVOKED */
  status: text('status').notNull().default('TRAINING'),
  trainingPassedAt: ts('training_passed_at'),
  /** `/files/<id>` uploaded by the courier (ALCOHOL responsible-service certificate) */
  certificateFileUrl: text('certificate_file_url'),
  certificateExpiresAt: ts('certificate_expires_at'),
  submittedAt: ts('submitted_at'),
  decidedById: uuid('decided_by_id'),
  decidedAt: ts('decided_at'),
  note: text('note'),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('courier_certifications_driver_category_uq').on(t.driverId, t.category)]);
