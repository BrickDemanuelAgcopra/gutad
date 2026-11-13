import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { locations, merchantAgreementAcceptances, merchantContracts, merchantDocuments, organizations } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';

/** Bump when the Merchant Agreement text changes; merchants re-accept the new version. */
export const MERCHANT_AGREEMENT_VERSION = '2026-11-13.3';

export const DOCUMENT_TYPES = [
  { type: 'BUSINESS_LICENSE', label: 'Business license or registration', required: true },
  { type: 'FOOD_PERMIT', label: 'Food service / health department permit', required: true },
  { type: 'TAX_FORM', label: 'IRS Form W-9', required: true },
  { type: 'OWNER_ID', label: 'Government ID of the owner or authorized signer', required: true },
  { type: 'INSURANCE', label: 'Certificate of liability insurance', required: false },
  { type: 'OTHER', label: 'Other supporting document', required: false },
] as const;
export type DocType = (typeof DOCUMENT_TYPES)[number]['type'];

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const docColumns = {
  id: merchantDocuments.id,
  organizationId: merchantDocuments.organizationId,
  locationId: merchantDocuments.locationId,
  docType: merchantDocuments.docType,
  fileName: merchantDocuments.fileName,
  mimeType: merchantDocuments.mimeType,
  sizeBytes: merchantDocuments.sizeBytes,
  status: merchantDocuments.status,
  reviewNote: merchantDocuments.reviewNote,
  reviewedAt: merchantDocuments.reviewedAt,
  createdAt: merchantDocuments.createdAt,
};

@Injectable()
export class OnboardingService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  private async latestContract(orgId: string) {
    const [c] = await this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version)).limit(1);
    return c ?? null;
  }

  private async currentAcceptance(orgId: string) {
    const [a] = await this.db
      .select()
      .from(merchantAgreementAcceptances)
      .where(and(eq(merchantAgreementAcceptances.organizationId, orgId), eq(merchantAgreementAcceptances.agreementVersion, MERCHANT_AGREEMENT_VERSION)))
      .orderBy(desc(merchantAgreementAcceptances.acceptedAt))
      .limit(1);
    return a ?? null;
  }

  private async documents(orgId: string) {
    return this.db.select(docColumns).from(merchantDocuments).where(eq(merchantDocuments.organizationId, orgId)).orderBy(desc(merchantDocuments.createdAt));
  }

  /** Per required type, the status of the most recently uploaded document (APPROVED wins if any copy is approved). */
  private requiredStatus(docs: Awaited<ReturnType<OnboardingService['documents']>>) {
    return DOCUMENT_TYPES.map((t) => {
      const ofType = docs.filter((d) => d.docType === t.type);
      const status = ofType.some((d) => d.status === 'APPROVED') ? 'APPROVED' : ofType[0]?.status ?? 'MISSING';
      return { ...t, status, reviewNote: ofType[0]?.status === 'REJECTED' ? ofType[0].reviewNote : null };
    });
  }

  /** Human-readable reasons the organization cannot be verified yet; empty when onboarding is complete. */
  async blockers(orgId: string) {
    const out: string[] = [];
    if (!(await this.currentAcceptance(orgId))) out.push('Merchant Agreement not accepted');
    const c = await this.latestContract(orgId);
    if (!c) out.push('no Order Form assigned (Admin > Commercial: assign contract)');
    else if (!c.signedAt) out.push('Order Form not signed by the merchant');
    const req = this.requiredStatus(await this.documents(orgId)).filter((r) => r.required && r.status !== 'APPROVED');
    for (const r of req) out.push(`${r.label}: ${r.status === 'MISSING' ? 'not uploaded' : r.status === 'SUBMITTED' ? 'awaiting review' : 'rejected, re-upload needed'}`);
    return out;
  }

  async status(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new NotFoundException();
    const acceptance = await this.currentAcceptance(orgId);
    const contract = await this.latestContract(orgId);
    const docs = await this.documents(orgId);
    const locs = await this.db.select({ id: locations.id, name: locations.name, status: locations.status, verifiedAt: locations.verifiedAt }).from(locations).where(eq(locations.organizationId, orgId));
    return {
      agreementVersion: MERCHANT_AGREEMENT_VERSION,
      agreement: acceptance ? { acceptedAt: acceptance.acceptedAt, signatureName: acceptance.signatureName, signatureTitle: acceptance.signatureTitle } : null,
      orderForm: contract
        ? { id: contract.id, name: contract.name, planCode: contract.planCode, version: contract.version, marketplaceCommissionBps: contract.marketplaceCommissionBps, directCommissionBps: contract.directCommissionBps, subscriptionCents: contract.subscriptionCents, subscriptionInterval: contract.subscriptionInterval, processingBps: contract.processingBps, processingFixedCents: contract.processingFixedCents, effectiveFrom: contract.effectiveFrom, signedAt: contract.signedAt }
        : null,
      documentTypes: this.requiredStatus(docs),
      documents: docs,
      locations: locs,
      blockers: await this.blockers(orgId),
    };
  }

  /** The owner signs the current Merchant Agreement and, if one is waiting, the Order Form. */
  async accept(user: JwtPayload, orgId: string, input: { agreementVersion: string; signatureName: string; signatureTitle?: string; contractId?: string }, meta: { ip?: string; userAgent?: string }) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER']);
    if (input.agreementVersion !== MERCHANT_AGREEMENT_VERSION) throw new BadRequestException('The agreement changed since you opened it. Reload and review the current version.');
    let contractId: string | null = null;
    if (input.contractId) {
      const [c] = await this.db.select().from(merchantContracts).where(and(eq(merchantContracts.id, input.contractId), eq(merchantContracts.organizationId, orgId))).limit(1);
      if (!c) throw new NotFoundException('Order Form not found');
      contractId = c.id;
    }
    return this.db.transaction(async (tx) => {
      const [a] = await tx
        .insert(merchantAgreementAcceptances)
        .values({ organizationId: orgId, agreementVersion: MERCHANT_AGREEMENT_VERSION, contractId, acceptedById: user.sub, signatureName: input.signatureName.trim(), signatureTitle: input.signatureTitle?.trim() || null, ipAddress: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 400) ?? null })
        .returning();
      if (contractId) await tx.update(merchantContracts).set({ signedAt: new Date() }).where(and(eq(merchantContracts.id, contractId), eq(merchantContracts.organizationId, orgId)));
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'agreement.accept', entityType: 'organization', entityId: orgId, after: { agreementVersion: MERCHANT_AGREEMENT_VERSION, contractId, signatureName: a.signatureName } }, tx);
      return a;
    });
  }

  async upload(user: JwtPayload, orgId: string, file: UploadedFile | undefined, docType: string, locationId?: string) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    if (!file) throw new BadRequestException('Attach a file');
    if (!DOCUMENT_TYPES.some((t) => t.type === docType)) throw new BadRequestException('Unknown document type');
    if (file.size > MAX_DOCUMENT_BYTES) throw new BadRequestException('File is larger than 10 MB');
    if (!ALLOWED_MIME.includes(file.mimetype)) throw new BadRequestException('Upload a PDF or an image (JPG, PNG, WEBP, HEIC)');
    if (locationId) {
      const [l] = await this.db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId))).limit(1);
      if (!l) throw new BadRequestException('Location does not belong to this organization');
    }
    const [row] = await this.db
      .insert(merchantDocuments)
      .values({ organizationId: orgId, locationId: locationId || null, docType, fileName: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, content: file.buffer, uploadedById: user.sub })
      .returning(docColumns);
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'document.upload', entityType: 'merchant_document', entityId: row.id, after: { docType, fileName: row.fileName, sizeBytes: row.sizeBytes } });
    return row;
  }

  async list(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.documents(orgId);
  }

  async file(user: JwtPayload, docId: string) {
    const [d] = await this.db.select().from(merchantDocuments).where(eq(merchantDocuments.id, docId)).limit(1);
    if (!d) throw new NotFoundException();
    assertOrgAccess(user, d.organizationId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    return d;
  }

  async review(user: JwtPayload, docId: string, status: 'APPROVED' | 'REJECTED', note?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Platform staff only');
    if (status === 'REJECTED' && !note) throw new BadRequestException('Tell the merchant why the document was rejected');
    const [row] = await this.db.update(merchantDocuments).set({ status, reviewNote: note ?? null, reviewedById: user.sub, reviewedAt: new Date() }).where(eq(merchantDocuments.id, docId)).returning(docColumns);
    if (!row) throw new NotFoundException();
    await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: `document.${status.toLowerCase()}`, entityType: 'merchant_document', entityId: docId, after: { status, note } });
    return row;
  }

  /** Staff queue: documents waiting for review, with the organization name. */
  async reviewQueue(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const docs = await this.db.select(docColumns).from(merchantDocuments).where(eq(merchantDocuments.status, 'SUBMITTED')).orderBy(merchantDocuments.createdAt).limit(200);
    const orgIds = [...new Set(docs.map((d) => d.organizationId))];
    const orgs = orgIds.length ? await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
    return docs.map((d) => ({ ...d, organizationName: orgs.find((o) => o.id === d.organizationId)?.name ?? '' }));
  }
}
