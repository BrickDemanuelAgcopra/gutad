// 02 Merchant onboarding — agreement acceptance and verification documents
import { customType, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { organizations, users } from './accounts';
import { locations } from './merchants';
import { merchantContracts } from './finance';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** A merchant accepting the Gutad Merchant Agreement (and, when one exists, its Order Form contract). */
export const merchantAgreementAcceptances = pgTable(
  'merchant_agreement_acceptances',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agreementVersion: text('agreement_version').notNull(),
    contractId: uuid('contract_id').references(() => merchantContracts.id),
    acceptedById: uuid('accepted_by_id')
      .notNull()
      .references(() => users.id),
    signatureName: text('signature_name').notNull(),
    signatureTitle: text('signature_title'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    acceptedAt: createdAt(),
  },
  (t) => [index('agreement_acceptances_org_idx').on(t.organizationId)],
);

/** Business documents uploaded during onboarding and reviewed by platform staff before verification. */
export const merchantDocuments = pgTable(
  'merchant_documents',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytea('content').notNull(),
    status: text('status').notNull().default('SUBMITTED'), // SUBMITTED | APPROVED | REJECTED
    reviewNote: text('review_note'),
    reviewedById: uuid('reviewed_by_id').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('merchant_documents_org_idx').on(t.organizationId)],
);
