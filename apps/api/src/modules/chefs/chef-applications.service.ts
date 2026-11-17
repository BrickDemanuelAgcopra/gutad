import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  CHEF_AGREEMENT_VERSION,
  CHEF_APPLICATION_STEPS,
  chefApplicationMissing,
  chefApplicationProgress,
  requirementsFor,
  type ChefApplicationData,
  type ChefDocRequirement,
  type ChefStepKey,
} from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { chefApplications, chefDocRequirements, chefDocuments, chefProfiles, legalSellers, locations, openingHours, organizations, orgMemberships, users } from '../../db/schema';
import { assertCan, can, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { ChefFilesService, IncomingFile } from './chef-files.service';
import { ChefDishesService } from './chef-dishes.service';

type App = typeof chefApplications.$inferSelect;
const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];
const STEP_KEYS = CHEF_APPLICATION_STEPS.map((s) => s.key).filter((k) => k !== 'documents') as Exclude<ChefStepKey, 'documents'>[];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chef';

@Injectable()
export class ChefApplicationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly files: ChefFilesService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
    private readonly dishes: ChefDishesService,
  ) {}

  // ───────────────────────── requirements ─────────────────────────

  async requirements(includeInactive = false): Promise<(ChefDocRequirement & { id: string; active: boolean; sortOrder: number })[]> {
    const rows = await this.db.select().from(chefDocRequirements).where(includeInactive ? undefined : eq(chefDocRequirements.active, true)).orderBy(asc(chefDocRequirements.sortOrder), asc(chefDocRequirements.label));
    return rows.map((r) => ({ id: r.id, key: r.key, label: r.label, description: r.description, regions: r.regions, kitchenTypes: r.kitchenTypes, required: r.required, needsExpiry: r.needsExpiry, active: r.active, sortOrder: r.sortOrder }));
  }

  async upsertRequirement(user: JwtPayload, input: { key: string; label: string; description?: string | null; regions?: string[]; kitchenTypes?: string[]; required?: boolean; needsExpiry?: boolean; active?: boolean; sortOrder?: number }) {
    assertCan(user, 'chefs.manage');
    const key = input.key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const values = { key, label: input.label, description: input.description ?? null, regions: (input.regions || []).map((r) => r.toUpperCase()), kitchenTypes: input.kitchenTypes || [], required: input.required ?? true, needsExpiry: input.needsExpiry ?? false, active: input.active ?? true, sortOrder: input.sortOrder ?? 50 };
    const [row] = await this.db.insert(chefDocRequirements).values(values).onConflictDoUpdate({ target: chefDocRequirements.key, set: values }).returning();
    await this.audit.configChange({ key: `chefs.requirement.${key}`, after: values, actorId: user.sub, approvedById: user.sub });
    return row;
  }

  // ───────────────────────── applicant ─────────────────────────

  private async byUser(userId: string) {
    const [a] = await this.db.select().from(chefApplications).where(eq(chefApplications.userId, userId)).limit(1);
    return a || null;
  }

  private async docsOf(appId: string) {
    return this.db.select().from(chefDocuments).where(eq(chefDocuments.applicationId, appId)).orderBy(desc(chefDocuments.createdAt));
  }

  /** Latest document per requirement (older uploads stay for history). */
  private latestDocs(docs: (typeof chefDocuments.$inferSelect)[]) {
    const seen = new Set<string>();
    return docs.filter((d) => (seen.has(d.requirementKey) ? false : (seen.add(d.requirementKey), true)));
  }

  private async view(a: App) {
    const reqs = await this.requirements();
    const data = (a.data || {}) as ChefApplicationData;
    const docs = this.latestDocs(await this.docsOf(a.id));
    const missing = chefApplicationMissing(data, docs.map((d) => ({ requirementKey: d.requirementKey, status: d.status, expiresAt: d.expiresAt?.toISOString() ?? null })), reqs);
    const progress = chefApplicationProgress(missing);
    const needed = requirementsFor(reqs, data.kitchen?.region, data.kitchen?.kitchenType);
    return {
      ...a,
      editable: EDITABLE.includes(a.status),
      agreementVersion: CHEF_AGREEMENT_VERSION,
      progress,
      requirements: needed,
      documents: docs.map((d) => ({ id: d.id, requirementKey: d.requirementKey, status: d.status, expiresAt: d.expiresAt, note: d.note, fileId: d.fileId, createdAt: d.createdAt })),
    };
  }

  async mine(user: JwtPayload) {
    const a = await this.byUser(user.sub);
    if (!a) return null;
    const v = await this.view(a);
    const [profile] = a.organizationId ? await this.db.select().from(chefProfiles).where(eq(chefProfiles.organizationId, a.organizationId)).limit(1) : [];
    return { ...v, profileId: profile?.id ?? null };
  }

  async start(user: JwtPayload) {
    const existing = await this.byUser(user.sub);
    if (existing) return this.view(existing);
    const [u] = await this.db.select().from(users).where(eq(users.id, user.sub)).limit(1);
    if (!u || u.isGuest) throw new ForbiddenException('Create an account to apply');
    const data: ChefApplicationData = { account: { phone: u.phone || undefined }, identity: { legalName: u.name || undefined } };
    const [a] = await this.db
      .insert(chefApplications)
      .values({ userId: user.sub, data, history: [{ at: new Date().toISOString(), by: user.sub, action: 'STARTED' }] })
      .onConflictDoNothing()
      .returning();
    return this.view(a || (await this.byUser(user.sub))!);
  }

  /** Autosave of one step. Only the fields of that step change. */
  async saveStep(user: JwtPayload, step: string, patch: Record<string, unknown>) {
    if (!STEP_KEYS.includes(step as never)) throw new BadRequestException('Unknown step');
    let a = await this.byUser(user.sub);
    if (!a) {
      await this.start(user);
      a = (await this.byUser(user.sub))!;
    }
    if (!EDITABLE.includes(a.status)) throw new ConflictException({ message: 'Your application is with our team; you can edit it again if they ask for changes', code: 'APPLICATION_LOCKED' });
    const data = { ...((a.data || {}) as Record<string, Record<string, unknown>>) };
    const next = { ...(data[step] || {}), ...patch };
    if (step === 'account' && patch.agreed === true) {
      next.agreedAt = new Date().toISOString();
      next.agreementVersion = CHEF_AGREEMENT_VERSION;
      delete next.agreed;
    }
    if (step === 'profile') {
      await this.files.assertOwnPhoto(user, next.portraitFileId as string | undefined);
      for (const f of (next.portfolioFileIds as string[] | undefined) || []) await this.files.assertOwnPhoto(user, f);
    }
    if (step === 'menu') for (const d of ((next.dishes as { photoFileId?: string }[]) || [])) await this.files.assertOwnPhoto(user, d.photoFileId);
    if (step === 'kitchen' && typeof next.region === 'string') next.region = next.region.toUpperCase().trim();
    data[step] = next;
    const d = data as ChefApplicationData;
    const [row] = await this.db
      .update(chefApplications)
      .set({ data, displayName: d.identity?.displayName || null, region: d.kitchen?.region || d.profile?.serviceRegion?.toUpperCase() || null, city: d.kitchen?.city || d.profile?.serviceCity || null, kitchenType: d.kitchen?.kitchenType || null })
      .where(eq(chefApplications.id, a.id))
      .returning();
    const v = await this.view(row);
    if (v.progress.percent !== row.percentComplete) await this.db.update(chefApplications).set({ percentComplete: v.progress.percent }).where(eq(chefApplications.id, a.id));
    return { ...v, percentComplete: v.progress.percent };
  }

  async uploadDocument(user: JwtPayload, file: IncomingFile | undefined, requirementKey: string, expiresAt?: string) {
    const a = await this.byUser(user.sub);
    if (!a) throw new NotFoundException('Start your application first');
    if (!EDITABLE.includes(a.status) && a.status !== 'APPROVED') throw new ConflictException({ message: 'Your application is with our team', code: 'APPLICATION_LOCKED' });
    const req = (await this.requirements()).find((r) => r.key === requirementKey);
    if (!req) throw new BadRequestException('Unknown document type');
    if (req.needsExpiry && !expiresAt) throw new BadRequestException('Enter the expiry date shown on the document');
    if (expiresAt && new Date(expiresAt) < new Date()) throw new BadRequestException('This document has already expired');
    const f = await this.files.store(user, file, 'CHEF_DOCUMENT');
    const [doc] = await this.db.insert(chefDocuments).values({ applicationId: a.id, requirementKey, fileId: f.id, expiresAt: expiresAt ? new Date(expiresAt) : null }).returning();
    await this.audit.log({ actorId: user.sub, action: 'chef.document_upload', entityType: 'chef_document', entityId: doc.id, after: { requirementKey, fileId: f.id, sizeBytes: f.sizeBytes } });
    return { ...doc, file: { id: f.id, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes } };
  }

  async submit(user: JwtPayload) {
    const a = await this.byUser(user.sub);
    if (!a) throw new NotFoundException('Start your application first');
    if (!EDITABLE.includes(a.status)) throw new ConflictException({ message: 'Already submitted', code: 'APPLICATION_LOCKED' });
    const v = await this.view(a);
    if (!v.progress.ready) throw new BadRequestException({ message: 'Finish every step before submitting', code: 'APPLICATION_INCOMPLETE', missing: v.progress.steps.filter((s) => !s.complete).map((s) => ({ step: s.key, missing: s.missing })) });
    return this.autoCheck(a, user.sub, a.status === 'CHANGES_REQUESTED' ? 'RESUBMITTED' : 'SUBMITTED');
  }

  /** Automated checks on submission: completeness, duplicate identities, and whether Gutad is accepting chefs in the region. */
  private async autoCheck(a: App, actorId: string, action: string) {
    const data = a.data as ChefApplicationData;
    const flags: string[] = [];
    const phoneDigits = (data.account?.phone || '').replace(/\D/g, '').slice(-10);
    if (phoneDigits) {
      const dup = await this.db.select({ id: chefApplications.id }).from(chefApplications).where(and(sql`right(regexp_replace(${chefApplications.data}->'account'->>'phone', '\\D', '', 'g'), 10) = ${phoneDigits}`, sql`${chefApplications.id} <> ${a.id}`)).limit(1);
      if (dup.length) flags.push('Another application uses the same phone number');
    }
    const open = await this.settings.get<string[]>('chefs.open_regions', []);
    const region = (data.kitchen?.region || '').toUpperCase();
    const waitlist = open.length > 0 && !open.map((r) => r.toUpperCase()).includes(region);
    const status = waitlist ? 'WAITLISTED' : 'SUBMITTED';
    const hist = [...((a.history as unknown[]) || []), { at: new Date().toISOString(), by: actorId, action, note: waitlist ? `Gutad is not accepting chefs in ${region} yet` : flags.join('; ') || undefined }];
    const [row] = await this.db
      .update(chefApplications)
      .set({ status, submittedAt: new Date(), percentComplete: 100, autoCheck: { at: new Date().toISOString(), complete: true, flags, waitlist }, history: hist, correctionSteps: [] })
      .where(eq(chefApplications.id, a.id))
      .returning();
    await this.notify.queue({ userId: a.userId, template: waitlist ? 'chef.application.waitlisted' : 'chef.application.received', payload: { displayName: data.identity?.displayName, region }, dedupeKey: `chef.app:${a.id}:${action}:${hist.length}` });
    await this.audit.log({ actorId, action: `chef.application.${action.toLowerCase()}`, entityType: 'chef_application', entityId: a.id, after: { status, flags } });
    return this.view(row);
  }

  async appeal(user: JwtPayload, note: string) {
    const a = await this.byUser(user.sub);
    if (!a) throw new NotFoundException();
    if (a.status !== 'REJECTED') throw new ConflictException('Only a declined application can be appealed');
    const [row] = await this.db
      .update(chefApplications)
      .set({ status: 'APPEALED', appealNote: note, history: [...((a.history as unknown[]) || []), { at: new Date().toISOString(), by: user.sub, action: 'APPEALED', note }] })
      .where(eq(chefApplications.id, a.id))
      .returning();
    await this.audit.log({ actorId: user.sub, action: 'chef.application.appeal', entityType: 'chef_application', entityId: a.id, after: { note } });
    return this.view(row);
  }

  async readFile(user: JwtPayload, fileId: string) {
    return this.files.read(user, fileId);
  }

  // ───────────────────────── admin ─────────────────────────

  async list(user: JwtPayload, q: { status?: string; region?: string; mine?: boolean }) {
    assertCan(user, 'chefs.read');
    const where = [];
    if (q.status) where.push(inArray(chefApplications.status, q.status.split(',')));
    else where.push(sql`${chefApplications.status} <> 'DRAFT'`);
    if (q.region) where.push(eq(chefApplications.region, q.region.toUpperCase()));
    if (q.mine) where.push(eq(chefApplications.reviewerId, user.sub));
    const rows = await this.db
      .select({ a: chefApplications, email: users.email, name: users.name })
      .from(chefApplications)
      .innerJoin(users, eq(users.id, chefApplications.userId))
      .where(and(...where))
      .orderBy(desc(chefApplications.submittedAt), desc(chefApplications.updatedAt))
      .limit(300);
    const counts = await this.db.select({ status: chefApplications.status, n: sql<number>`count(*)::int` }).from(chefApplications).groupBy(chefApplications.status);
    const reviewerIds = [...new Set(rows.map((r) => r.a.reviewerId).filter(Boolean))] as string[];
    const reviewers = reviewerIds.length ? await this.db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id, reviewerIds)) : [];
    const ageHours = (d: Date | null) => (d ? Math.round((Date.now() - d.getTime()) / 3_600_000) : null);
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      items: rows.map(({ a, email, name }) => ({
        id: a.id,
        status: a.status,
        displayName: a.displayName,
        applicantName: name,
        email,
        region: a.region,
        city: a.city,
        kitchenType: a.kitchenType,
        percentComplete: a.percentComplete,
        flags: ((a.autoCheck as { flags?: string[] } | null)?.flags || []),
        reviewer: reviewers.find((r) => r.id === a.reviewerId) || null,
        submittedAt: a.submittedAt,
        waitingHours: ['SUBMITTED', 'IN_REVIEW', 'APPEALED'].includes(a.status) ? ageHours(a.submittedAt) : null,
        updatedAt: a.updatedAt,
      })),
    };
  }

  async detail(user: JwtPayload, id: string) {
    assertCan(user, 'chefs.read');
    const [a] = await this.db.select().from(chefApplications).where(eq(chefApplications.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    const [u] = await this.db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone, emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt }).from(users).where(eq(users.id, a.userId)).limit(1);
    const allDocs = await this.docsOf(a.id);
    const v = await this.view(a);
    return { ...v, applicant: u, documentHistory: allDocs };
  }

  private async load(id: string) {
    const [a] = await this.db.select().from(chefApplications).where(eq(chefApplications.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    return a;
  }

  private push(a: App, by: string, action: string, note?: string) {
    return [...((a.history as unknown[]) || []), { at: new Date().toISOString(), by, action, note }];
  }

  async assign(user: JwtPayload, id: string, reviewerId?: string | null) {
    assertCan(user, 'chefs.manage');
    const a = await this.load(id);
    const rid = reviewerId === undefined ? user.sub : reviewerId;
    if (rid) {
      const [r] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, rid)).limit(1);
      if (!r) throw new BadRequestException('Reviewer not found');
    }
    const status = ['SUBMITTED', 'APPEALED', 'WAITLISTED'].includes(a.status) && rid ? 'IN_REVIEW' : a.status;
    const [row] = await this.db.update(chefApplications).set({ reviewerId: rid, status, history: this.push(a, user.sub, 'ASSIGNED', rid || 'unassigned') }).where(eq(chefApplications.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'chef.application.assign', entityType: 'chef_application', entityId: id, after: { reviewerId: rid, status } });
    return row;
  }

  async reviewDocument(user: JwtPayload, docId: string, input: { status: 'APPROVED' | 'REJECTED'; note?: string; expiresAt?: string | null }) {
    assertCan(user, 'chefs.manage');
    const [d] = await this.db.select().from(chefDocuments).where(eq(chefDocuments.id, docId)).limit(1);
    if (!d) throw new NotFoundException();
    if (input.status === 'REJECTED' && !(input.note || '').trim()) throw new BadRequestException('Tell the chef why the document was not accepted');
    const [row] = await this.db
      .update(chefDocuments)
      .set({ status: input.status, note: input.note || null, reviewedById: user.sub, reviewedAt: new Date(), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}) })
      .where(eq(chefDocuments.id, docId))
      .returning();
    await this.audit.log({ actorId: user.sub, action: `chef.document.${input.status.toLowerCase()}`, entityType: 'chef_document', entityId: docId, after: { status: input.status, note: input.note } });
    return row;
  }

  async requestChanges(user: JwtPayload, id: string, input: { steps: string[]; note: string }) {
    assertCan(user, 'chefs.manage');
    const a = await this.load(id);
    if (!['SUBMITTED', 'IN_REVIEW', 'APPEALED', 'WAITLISTED'].includes(a.status)) throw new ConflictException(`Cannot request changes from ${a.status}`);
    const steps = input.steps.filter((s) => CHEF_APPLICATION_STEPS.some((x) => x.key === s));
    if (!steps.length) throw new BadRequestException('Choose the steps the chef must correct');
    const [row] = await this.db
      .update(chefApplications)
      .set({ status: 'CHANGES_REQUESTED', correctionSteps: steps, reviewNote: input.note, reviewerId: a.reviewerId || user.sub, history: this.push(a, user.sub, 'CHANGES_REQUESTED', `${steps.join(', ')}: ${input.note}`) })
      .where(eq(chefApplications.id, id))
      .returning();
    await this.notify.queue({ userId: a.userId, template: 'chef.application.changes', payload: { note: input.note, steps: steps.map((s) => CHEF_APPLICATION_STEPS.find((x) => x.key === s)?.label).join(', ') }, dedupeKey: `chef.app:${id}:changes:${(row.history as unknown[]).length}` });
    await this.audit.log({ actorId: user.sub, action: 'chef.application.changes', entityType: 'chef_application', entityId: id, after: { steps, note: input.note } });
    return row;
  }

  async decide(user: JwtPayload, id: string, input: { decision: 'APPROVE' | 'REJECT' | 'WAITLIST'; reason: string }) {
    assertCan(user, 'chefs.manage');
    if (!isPlatformStaff(user) || !can(user, 'chefs.manage')) throw new ForbiddenException();
    if ((input.reason || '').trim().length < 5) throw new BadRequestException({ message: 'A reason is required', code: 'REASON_REQUIRED' });
    const a = await this.load(id);
    if (!['SUBMITTED', 'IN_REVIEW', 'APPEALED', 'WAITLISTED'].includes(a.status)) throw new ConflictException(`Cannot decide an application that is ${a.status}`);
    if (input.decision === 'APPROVE') return this.approve(user, a, input.reason);
    const status = input.decision === 'REJECT' ? 'REJECTED' : 'WAITLISTED';
    const [row] = await this.db
      .update(chefApplications)
      .set({ status, decisionReason: input.reason, decidedAt: new Date(), history: this.push(a, user.sub, status, input.reason) })
      .where(eq(chefApplications.id, id))
      .returning();
    await this.notify.queue({ userId: a.userId, template: status === 'REJECTED' ? 'chef.application.rejected' : 'chef.application.waitlisted', payload: { reason: input.reason }, dedupeKey: `chef.app:${id}:${status}:${(row.history as unknown[]).length}` });
    await this.audit.log({ actorId: user.sub, action: `chef.application.${status.toLowerCase()}`, entityType: 'chef_application', entityId: id, reason: input.reason });
    return row;
  }

  /**
   * Approval considers the kitchen and permitted activity, not just identity: every required document for
   * the kitchen's region and type must be approved and current. Approval provisions the chef organization,
   * the paying legal seller, the kitchen location (paused until the chef opens availability) and the profile.
   */
  private async approve(user: JwtPayload, a: App, reason: string) {
    const v = await this.view(a);
    const notDone = v.progress.steps.filter((s) => s.key !== 'documents' && !s.complete);
    if (notDone.length) throw new BadRequestException({ message: `The application is incomplete: ${notDone.map((s) => s.label).join(', ')}`, code: 'APPLICATION_INCOMPLETE' });
    const approvedKeys = new Set(v.documents.filter((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date())).map((d) => d.requirementKey));
    const missing = v.requirements.filter((r) => r.required && !approvedKeys.has(r.key));
    if (missing.length) throw new BadRequestException({ message: `Approve these documents first: ${missing.map((m) => m.label).join(', ')}`, code: 'DOCS_MISSING' });
    const d = a.data as ChefApplicationData;
    const display = d.identity!.displayName!.trim();
    const legalName = d.identity?.businessType === 'BUSINESS' && d.identity.businessName ? d.identity.businessName.trim() : d.identity!.legalName!.trim();
    const op = d.operating || {};
    const k = d.kitchen!;
    const result = await this.db.transaction(async (tx) => {
      let slug = slugify(display);
      const [taken] = await tx.select({ id: chefProfiles.id }).from(chefProfiles).where(eq(chefProfiles.slug, slug)).limit(1);
      if (taken) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      const [org] = await tx
        .insert(organizations)
        .values({ name: display, slug: `chef-${slug}-${Math.random().toString(36).slice(2, 6)}`, kind: 'CHEF', status: 'LIVE', statusReason: 'Chef Network approval', statusChangedAt: new Date(), contacts: [{ name: d.identity?.legalName, role: 'Chef', phone: d.account?.phone }], featureFlags: {} })
        .returning();
      await tx.insert(orgMemberships).values({ userId: a.userId, organizationId: org.id, role: 'MERCHANT_OWNER' }).onConflictDoNothing();
      const [seller] = await tx.insert(legalSellers).values({ organizationId: org.id, legalName, country: d.payments?.country || 'US' }).returning();
      const [loc] = await tx
        .insert(locations)
        .values({
          organizationId: org.id,
          legalSellerId: seller.id,
          name: `${display}’s kitchen`,
          slug: `chef-${slug}-${Math.random().toString(36).slice(2, 6)}`,
          description: d.profile?.bio || null,
          cuisine: d.profile?.cuisines || [],
          phone: d.account?.phone || null,
          addressLine1: k.addressLine1!,
          addressLine2: k.addressLine2 || null,
          city: k.city!,
          region: k.region!,
          postalCode: k.postalCode!,
          pickupInstructions: k.pickupAccess || null,
          courierInstructions: k.pickupAccess || null,
          acceptsPickup: op.pickup !== false,
          acceptsDelivery: !!op.delivery,
          scheduleLeadMinutes: Math.max(0, (op.minLeadDays || 0) * 24 * 60),
          status: 'VERIFIED',
          verifiedAt: new Date(),
          isPaused: true,
          pausedReason: 'The chef has not opened availability yet',
          chefKitchen: true,
          defaultPrepMinutes: 45,
        })
        .returning();
      const days = op.cookingDays?.length ? op.cookingDays : [1, 2, 3, 4, 5];
      await tx.insert(openingHours).values(days.map((dayOfWeek) => ({ locationId: loc.id, dayOfWeek, opens: '09:00', closes: '20:00' })));
      const [profile] = await tx
        .insert(chefProfiles)
        .values({
          organizationId: org.id,
          userId: a.userId,
          applicationId: a.id,
          locationId: loc.id,
          displayName: display,
          slug,
          legalName,
          businessType: d.identity?.businessType || 'INDIVIDUAL',
          bio: d.profile?.bio || null,
          portraitFileId: d.profile?.portraitFileId || null,
          portfolioFileIds: d.profile?.portfolioFileIds || [],
          cuisines: d.profile?.cuisines || [],
          languages: d.profile?.languages || [],
          experienceYears: d.profile?.experienceYears ?? null,
          serviceCity: d.profile?.serviceCity || k.city || null,
          serviceRegion: (d.profile?.serviceRegion || k.region || '').toUpperCase() || null,
          serviceRadiusKm: d.profile?.serviceRadiusKm ?? 10,
          kitchenType: k.kitchenType || null,
          operating: { cookingDays: days, cutoffHour: op.cutoffHour ?? 12, minLeadDays: op.minLeadDays ?? 1, dailyCapacity: op.dailyCapacity ?? k.dailyCapacity ?? 10, instantOrders: !!op.instantOrders, scheduledOrders: op.scheduledOrders !== false, maxAdvanceDays: op.maxAdvanceDays ?? 30 },
          verifiedCredentials: [...approvedKeys],
          brandAgreementAcceptedAt: d.account?.agreedAt ? new Date(d.account.agreedAt) : new Date(),
          status: 'ACTIVE',
          acceptingOrders: false,
        })
        .returning();
      await tx.update(users).set({ roles: sql`array_append(array_remove(${users.roles}, 'CHEF'), 'CHEF')` }).where(eq(users.id, a.userId));
      await tx
        .update(chefApplications)
        .set({ status: 'APPROVED', organizationId: org.id, decisionReason: reason, decidedAt: new Date(), history: this.push(a, user.sub, 'APPROVED', reason) })
        .where(eq(chefApplications.id, a.id));
      await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'chef.application.approve', entityType: 'chef_application', entityId: a.id, after: { organizationId: org.id, locationId: loc.id, profileId: profile.id }, reason }, tx);
      return { organization: org, location: loc, profile, legalSellerId: seller.id };
    });
    // the starter menu from the application becomes draft dishes in the builder
    await this.dishes.importStarter(result.profile.id, d.menu?.dishes || []).catch(() => undefined);
    await this.notify.queue({ userId: a.userId, template: 'chef.application.approved', payload: { displayName: display }, dedupeKey: `chef.app:${a.id}:approved` });
    return { ...(await this.load(a.id)), ...result };
  }
}
