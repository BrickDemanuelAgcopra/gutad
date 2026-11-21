import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import {
  COURIER_AGREEMENT_VERSION, COURIER_OPERATING_MODEL, DEFAULT_RECRUITMENT, ELIGIBILITY_CHECKS, EQUIPMENT_ITEMS, MOTOR_VEHICLES, ONBOARDING_STEPS,
  REQUIRED_EQUIPMENT, REVIEW_EDIT_DAYS, REVIEW_ISSUES, REVIEW_TAGS_NEGATIVE, REVIEW_TAGS_POSITIVE, SCREENING_CONSENT_VERSION, TRAINING_MODULES, TRIP_ISSUES,
  requiredDocsFor, type EligibilityCheck, type RecruitmentConfig, type ReviewIssue, type TripIssue,
} from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import {
  courierDocuments, courierEligibility, courierRecords, courierShifts, courierTimeEntries, deliveryJobs, deliveryReviews, deliveryZones, driverEarnings,
  driverOffers, drivers, incidents, locations, opsAlerts, orders, payouts, users,
} from '../../db/schema';
import { assertCan, can, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { SettingsService } from '../../core/settings.service';
import { DeliveryService } from './delivery.service';

type Driver = typeof drivers.$inferSelect;
type Job = typeof deliveryJobs.$inferSelect;
type Onb = {
  location?: { country: string; city: string; zoneIds: string[]; transport: string; at: string };
  profile?: { legalName: string; addressLine1: string; city: string; postalCode: string; phone: string; languages: string[]; photoUrl?: string; at: string };
  vehicle?: { make?: string; model?: string; plate?: string; color?: string; year?: number; at: string };
  screening?: { consentVersion: string; consentedAt: string };
  payout?: { method: string; accountHolder: string; accountLast4: string; taxFormAcceptedAt: string };
  agreement?: { version: string; acceptedAt: string; operatingModel: string };
  training?: Record<string, string>;
  equipment?: { items: string[]; photoUrl?: string; at: string };
};
const STEP_CHECK: Record<string, EligibilityCheck | undefined> = { identity: 'IDENTITY', vehicle: 'VEHICLE', screening: 'SCREENING', payout: 'PAYOUT', agreement: 'AGREEMENT', training: 'TRAINING', equipment: 'EQUIPMENT' };
const EDITABLE = ['DRAFT', 'NEEDS_ACTION'];
const BLOCKLIST = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|retard\w*|n[i1]gg\w*|whore\w*)\b/i;
const mins = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);

/** Courier Release 1: onboarding, eligibility, lifecycle, availability, trip problems, itemized earnings and delivery reviews. */
@Injectable()
export class CourierService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
  ) {}

  recruitmentCfg() { return this.settings.getObject<RecruitmentConfig>('delivery.recruitment', DEFAULT_RECRUITMENT); }

  private async mine(user: JwtPayload) {
    const [d] = await this.db.select().from(drivers).where(eq(drivers.userId, user.sub)).limit(1);
    return d ?? null;
  }
  private async requireMine(user: JwtPayload) {
    const d = await this.mine(user);
    if (!d) throw new BadRequestException({ message: 'Start your application with where you’ll deliver', code: 'NO_APPLICATION' });
    return d;
  }
  private async requireDriver(id: string) {
    const [d] = await this.db.select().from(drivers).where(eq(drivers.id, id)).limit(1);
    if (!d) throw new NotFoundException('Courier not found');
    return d;
  }

  // ───── eligibility checks ─────

  /** Upsert one check, keeping its history. A no-op when nothing changes. */
  async setCheck(driverId: string, check: EligibilityCheck, status: string, opts: { note?: string | null; by?: string | null; expiresAt?: Date | null; provider?: string; providerRef?: string } = {}, tx: DbOrTx = this.db) {
    const [cur] = await tx.select().from(courierEligibility).where(and(eq(courierEligibility.driverId, driverId), eq(courierEligibility.check, check))).limit(1);
    if (cur && cur.status === status && (opts.note === undefined || cur.note === opts.note) && opts.expiresAt === undefined) return cur;
    const entry = { at: new Date().toISOString(), status, by: opts.by ?? null, note: opts.note ?? null };
    const values = { status, note: opts.note === undefined ? (cur?.note ?? null) : opts.note, decidedById: opts.by ?? null, expiresAt: opts.expiresAt === undefined ? (cur?.expiresAt ?? null) : opts.expiresAt, provider: opts.provider ?? cur?.provider ?? null, providerRef: opts.providerRef ?? cur?.providerRef ?? null, updatedAt: new Date() };
    if (cur) {
      const [u] = await tx.update(courierEligibility).set({ ...values, history: [...((cur.history as unknown[]) || []), entry] }).where(eq(courierEligibility.id, cur.id)).returning();
      return u;
    }
    const [u] = await tx.insert(courierEligibility).values({ driverId, check, ...values, history: [entry] }).onConflictDoNothing().returning();
    return u;
  }

  /** Identity and vehicle checks follow the documents: approved → PASSED, rejected → NEEDS_ACTION, uploaded → PENDING. */
  async syncDocChecks(driverId: string, tx: DbOrTx = this.db) {
    const d = await this.requireDriver(driverId);
    const docs = await tx.select().from(courierDocuments).where(eq(courierDocuments.driverId, driverId)).orderBy(desc(courierDocuments.createdAt));
    const latest = (kind: string) => docs.find((x) => x.kind === kind);
    const state = (kinds: string[]) => {
      const ls = kinds.map(latest);
      if (ls.some((x) => x?.status === 'REJECTED')) return { status: 'NEEDS_ACTION', note: ls.find((x) => x?.status === 'REJECTED')?.reviewNote ?? 'A document was rejected; upload a new one' };
      if (ls.every((x) => x?.status === 'APPROVED' && (!x.expiresAt || x.expiresAt > new Date()))) return { status: 'PASSED', note: null };
      if (ls.some((x) => x && x.status === 'EXPIRED')) return { status: 'EXPIRED', note: 'A document has expired' };
      if (ls.some((x) => x)) return { status: 'PENDING', note: 'Waiting for document review' };
      return { status: 'NOT_STARTED', note: null };
    };
    const checks = await tx.select().from(courierEligibility).where(eq(courierEligibility.driverId, driverId));
    const apply = async (check: EligibilityCheck, s: { status: string; note: string | null }) => {
      const cur = checks.find((c) => c.check === check);
      // an approved courier's passed check is only lowered by expiry or rejection, never by a new upload
      if (d.applicationStatus === 'APPROVED' && cur?.status === 'PASSED' && ['PENDING', 'NOT_STARTED'].includes(s.status)) return;
      if (cur?.status === 'FAILED') return; // staff decisions stand
      await this.setCheck(driverId, check, s.status, { note: s.note }, tx);
    };
    await apply('IDENTITY', state(['ID']));
    const vdocs = requiredDocsFor(d.vehicleType).filter((k) => k !== 'ID');
    const ob = d.onboarding as Onb;
    if (ob.vehicle || vdocs.length) await apply('VEHICLE', vdocs.length ? state(vdocs) : { status: ob.vehicle ? 'PASSED' : 'NOT_STARTED', note: null });
  }

  // ───── onboarding view ─────

  async availabilityFor(city: string) {
    const cfg = await this.recruitmentCfg();
    const key = city.trim().toLowerCase();
    const cc = cfg.cities?.[key];
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.status, 'LIVE'), eq(locations.acceptsDelivery, true), sql`lower(${locations.city}) = ${key}`));
    if (!cfg.open || cc?.open === false) return { serviceable: n > 0, waitlist: true, message: `We aren’t taking new couriers in ${city} right now. You can apply and join the waitlist.` };
    if (!n) return { serviceable: false, waitlist: true, message: `Gutad doesn’t deliver in ${city} yet. You can apply and we’ll put you on the waitlist.` };
    if (cc?.maxActive) {
      const [{ a }] = await this.db.select({ a: sql<number>`count(*)::int` }).from(drivers).where(and(sql`lower(${drivers.city}) = ${key}`, eq(drivers.lifecycleStatus, 'ACTIVE')));
      if (a >= cc.maxActive) return { serviceable: true, waitlist: true, message: `We have all the couriers we need in ${city} for now. Apply and we’ll invite you from the waitlist.` };
    }
    return { serviceable: true, waitlist: false, message: `Good news: we’re taking couriers in ${city}.` };
  }

  private steps(d: Driver | null, user: { emailVerifiedAt: Date | null }, docs: (typeof courierDocuments.$inferSelect)[], checks: (typeof courierEligibility.$inferSelect)[], cfg: RecruitmentConfig) {
    const ob = (d?.onboarding || {}) as Onb;
    const latest = (kind: string) => docs.filter((x) => x.kind === kind).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const uploaded = (kind: string) => { const l = latest(kind); return !!l && l.status !== 'REJECTED'; };
    const vdocs = d ? requiredDocsFor(d.vehicleType).filter((k) => k !== 'ID') : [];
    const done: Record<string, boolean> = {
      location: !!ob.location,
      account: !!user.emailVerifiedAt || !cfg.requireVerifiedContact,
      profile: !!ob.profile,
      identity: uploaded('ID'),
      vehicle: !!ob.vehicle && vdocs.every(uploaded),
      screening: !!ob.screening,
      payout: !!ob.payout,
      agreement: ob.agreement?.version === COURIER_AGREEMENT_VERSION,
      training: TRAINING_MODULES.every((m) => !!ob.training?.[m.key]),
      equipment: REQUIRED_EQUIPMENT.every((i) => ob.equipment?.items.includes(i)),
    };
    return ONBOARDING_STEPS.map((s) => {
      const c = STEP_CHECK[s.key] ? checks.find((x) => x.check === STEP_CHECK[s.key]) : undefined;
      const rejected = s.key === 'identity' ? latest('ID')?.status === 'REJECTED' : s.key === 'vehicle' ? vdocs.some((k) => latest(k)?.status === 'REJECTED') : false;
      const needsAction = rejected || c?.status === 'NEEDS_ACTION' || c?.status === 'EXPIRED';
      return { key: s.key, label: s.label, done: done[s.key] && !needsAction, needsAction, note: needsAction ? (c?.note ?? (rejected ? 'A document was rejected; upload a new one' : undefined)) ?? undefined : undefined };
    });
  }

  async onboardingView(userId: string, driverId?: string) {
    const [u] = await this.db.select({ emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, userId)).limit(1);
    const [d] = driverId ? await this.db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1) : await this.db.select().from(drivers).where(eq(drivers.userId, userId)).limit(1);
    const cfg = await this.recruitmentCfg();
    const docs = d ? await this.db.select().from(courierDocuments).where(eq(courierDocuments.driverId, d.id)).orderBy(desc(courierDocuments.createdAt)) : [];
    const checks = d ? await this.db.select().from(courierEligibility).where(eq(courierEligibility.driverId, d.id)) : [];
    const steps = this.steps(d ?? null, u ?? { emailVerifiedAt: null }, docs, checks, cfg);
    const ob = (d?.onboarding || {}) as Onb;
    const missing = steps.filter((s) => !s.done).map((s) => s.label);
    return {
      driver: d ? { id: d.id, applicationStatus: d.applicationStatus, lifecycleStatus: d.lifecycleStatus, status: d.status, vehicleType: d.vehicleType, decisionNote: d.decisionNote, submittedAt: d.submittedAt, firstDeliveryAt: d.firstDeliveryAt } : null,
      steps,
      checks: ELIGIBILITY_CHECKS.map((c) => { const r = checks.find((x) => x.check === c); return { check: c, status: r?.status ?? 'NOT_STARTED', note: r?.note ?? null, expiresAt: r?.expiresAt ?? null }; }),
      data: { ...ob, payout: ob.payout ? { method: ob.payout.method, accountLast4: ob.payout.accountLast4, taxFormAcceptedAt: ob.payout.taxFormAcceptedAt } : undefined },
      requiredDocs: d ? requiredDocsFor(d.vehicleType) : ['ID'],
      documents: docs.map((x) => ({ id: x.id, kind: x.kind, status: x.status, expiresAt: x.expiresAt, reviewNote: x.reviewNote, fileUrl: x.fileUrl, fileId: x.fileId })),
      availability: ob.location ? await this.availabilityFor(ob.location.city) : undefined,
      canSubmit: !!d && EDITABLE.includes(d.applicationStatus) && missing.length === 0,
      missing,
    };
  }

  // ───── onboarding steps ─────

  async saveStep(user: JwtPayload, step: string, b: Record<string, unknown>) {
    let d = await this.mine(user);
    if (step === 'location') {
      const transport = String(b.transport);
      const zoneIds = (b.zoneIds as string[] | undefined) ?? [];
      if (zoneIds.length) {
        const zs = await this.db.select({ id: deliveryZones.id }).from(deliveryZones).where(inArray(deliveryZones.id, zoneIds));
        if (zs.length !== zoneIds.length) throw new BadRequestException('Unknown delivery area');
      }
      const location = { country: String(b.country), city: String(b.city).trim(), zoneIds, transport, at: new Date().toISOString() };
      if (!d) {
        [d] = await this.db.insert(drivers).values({ userId: user.sub, vehicle: transport, vehicleType: transport, city: location.city, zoneIds, applicationStatus: 'DRAFT', onboarding: { location } }).returning();
        await this.audit.log({ actorId: user.sub, action: 'courier.application_start', entityType: 'driver', entityId: d.id });
      } else {
        this.assertEditable(d);
        await this.db.update(drivers).set({ vehicle: transport, vehicleType: transport, city: location.city, zoneIds, onboarding: { ...(d.onboarding as Onb), location } }).where(eq(drivers.id, d.id));
        await this.syncDocChecks(d.id);
      }
      return this.onboardingView(user.sub);
    }
    if (!d) throw new BadRequestException({ message: 'Start your application with where you’ll deliver', code: 'NO_APPLICATION' });
    const ob = d.onboarding as Onb;
    const now = new Date().toISOString();
    const save = (patch: Partial<Onb>, extra: Partial<typeof drivers.$inferInsert> = {}) => this.db.update(drivers).set({ onboarding: { ...ob, ...patch }, ...extra }).where(eq(drivers.id, d!.id));
    switch (step) {
      case 'profile': {
        this.assertEditable(d);
        await save({ profile: { legalName: String(b.legalName), addressLine1: String(b.addressLine1), city: String(b.city), postalCode: String(b.postalCode), phone: String(b.phone), languages: (b.languages as string[]) ?? [], photoUrl: b.photoUrl as string | undefined, at: now } });
        break;
      }
      case 'vehicle': {
        this.assertEditable(d);
        if (MOTOR_VEHICLES.includes(d.vehicleType) && !(b.make && b.model && b.plate)) throw new BadRequestException({ message: 'Make, model and plate are required for this vehicle', code: 'VEHICLE_DETAILS' });
        const vehicle = { make: b.make as string | undefined, model: b.model as string | undefined, plate: b.plate as string | undefined, color: b.color as string | undefined, year: b.year as number | undefined, at: now };
        await save({ vehicle }, { vehicle: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || d.vehicleType });
        await this.syncDocChecks(d.id);
        break;
      }
      case 'screening': {
        this.assertEditable(d);
        if (b.consent !== true || b.consentVersion !== SCREENING_CONSENT_VERSION) throw new BadRequestException({ message: 'Consent to the current screening notice is required', code: 'CONSENT_REQUIRED' });
        await save({ screening: { consentVersion: SCREENING_CONSENT_VERSION, consentedAt: now } });
        await this.setCheck(d.id, 'SCREENING', 'PENDING', { note: 'Consent recorded; waiting for the screening result', provider: 'manual', providerRef: `scr_${d.id.slice(0, 8)}` });
        await this.audit.log({ actorId: user.sub, action: 'courier.screening_consent', entityType: 'driver', entityId: d.id, after: { version: SCREENING_CONSENT_VERSION } });
        break;
      }
      case 'payout': {
        if (!/^\d{4}$/.test(String(b.accountLast4))) throw new BadRequestException('Enter the last 4 digits of the account');
        if (b.taxFormAccepted !== true) throw new BadRequestException({ message: 'Confirm your tax details', code: 'TAX_REQUIRED' });
        // changing an existing payout account needs the password again
        if (ob.payout || d.payoutAccountId) {
          const [u] = await this.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.sub)).limit(1);
          if (!b.password || !u?.hash || !(await argon2.verify(u.hash, String(b.password)).catch(() => false))) throw new ForbiddenException({ message: 'Enter your password to change where your earnings go', code: 'PASSWORD_REQUIRED' });
        }
        const payout = { method: 'BANK', accountHolder: String(b.accountHolder), accountLast4: String(b.accountLast4), taxFormAcceptedAt: now };
        await save({ payout }, { payoutAccountId: `mock_acct_${d.id.slice(0, 8)}_${payout.accountLast4}`, payoutProvider: 'mock' });
        await this.setCheck(d.id, 'PAYOUT', 'PASSED', { note: `Account ending ${payout.accountLast4}`, provider: 'mock' });
        await this.audit.log({ actorId: user.sub, action: ob.payout ? 'courier.payout_change' : 'courier.payout_setup', entityType: 'driver', entityId: d.id, after: { accountLast4: payout.accountLast4 } });
        if (ob.payout) await this.db.insert(courierRecords).values({ driverId: d.id, kind: 'SUPPORT_NOTE', title: 'Payout account changed', detail: `Now ending ${payout.accountLast4} (confirmed with password)` });
        break;
      }
      case 'agreement': {
        this.assertEditable(d);
        if (b.accept !== true || b.version !== COURIER_AGREEMENT_VERSION) throw new BadRequestException({ message: 'Accept the current courier agreement', code: 'AGREEMENT_REQUIRED' });
        await save({ agreement: { version: COURIER_AGREEMENT_VERSION, acceptedAt: now, operatingModel: COURIER_OPERATING_MODEL } });
        await this.setCheck(d.id, 'AGREEMENT', 'PASSED', { note: COURIER_AGREEMENT_VERSION });
        await this.audit.log({ actorId: user.sub, action: 'courier.agreement_accept', entityType: 'driver', entityId: d.id, after: { version: COURIER_AGREEMENT_VERSION, operatingModel: COURIER_OPERATING_MODEL } });
        break;
      }
      case 'training': {
        const m = TRAINING_MODULES.find((x) => x.key === b.module);
        if (!m) throw new BadRequestException('Unknown training module');
        if (Number(b.answer) !== m.answer) throw new BadRequestException({ message: 'Not quite. Read the module again and try once more.', code: 'WRONG_ANSWER' });
        const training = { ...(ob.training || {}), [m.key]: now };
        await save({ training });
        if (TRAINING_MODULES.every((x) => training[x.key])) await this.setCheck(d.id, 'TRAINING', 'PASSED', { note: `${TRAINING_MODULES.length} modules completed` });
        break;
      }
      case 'equipment': {
        this.assertEditable(d);
        const items = ((b.items as string[]) ?? []).filter((i) => (EQUIPMENT_ITEMS as readonly string[]).includes(i));
        const lacking = REQUIRED_EQUIPMENT.filter((i) => !items.includes(i));
        if (lacking.length) throw new BadRequestException({ message: 'An insulated delivery bag is required', code: 'EQUIPMENT_REQUIRED' });
        await save({ equipment: { items, photoUrl: b.photoUrl as string | undefined, at: now } });
        await this.setCheck(d.id, 'EQUIPMENT', 'PENDING', { note: 'Staff will verify your equipment' });
        break;
      }
      default:
        throw new NotFoundException('Unknown onboarding step');
    }
    return this.onboardingView(user.sub);
  }

  private assertEditable(d: Driver) {
    if (!EDITABLE.includes(d.applicationStatus)) throw new ConflictException({ message: d.applicationStatus === 'APPROVED' ? 'Your account is approved; contact support to change these details' : 'Your application is with our team; you can edit it if we ask you to', code: 'NOT_EDITABLE' });
  }

  async submit(user: JwtPayload) {
    const d = await this.requireMine(user);
    if (!EDITABLE.includes(d.applicationStatus)) throw new ConflictException(`Application is ${d.applicationStatus.toLowerCase().replace('_', ' ')}`);
    await this.syncDocChecks(d.id);
    const view = await this.onboardingView(user.sub);
    if (view.missing.length) throw new BadRequestException({ message: `Finish these first: ${view.missing.join(', ')}`, code: 'ONBOARDING_INCOMPLETE', missing: view.missing });
    const avail = await this.availabilityFor((d.onboarding as Onb).location!.city);
    const next = avail.waitlist ? 'WAITLISTED' : 'VERIFICATION_PENDING';
    await this.db.update(drivers).set({ applicationStatus: next, submittedAt: new Date(), decisionNote: avail.waitlist ? avail.message : null }).where(eq(drivers.id, d.id));
    await this.audit.log({ actorId: user.sub, action: 'courier.application_submit', entityType: 'driver', entityId: d.id, after: { applicationStatus: next } });
    await this.outbox.publish('courier.decision', d.id, { userId: d.userId, applicationStatus: next });
    return this.onboardingView(user.sub);
  }

  async requestReactivation(user: JwtPayload, note: string) {
    const d = await this.requireMine(user);
    if (d.lifecycleStatus !== 'DEACTIVATED') throw new ConflictException('Only a deactivated account can ask to be reactivated');
    await this.db.update(drivers).set({ lifecycleStatus: 'REACTIVATION_PENDING', lifecycleReason: note }).where(eq(drivers.id, d.id));
    await this.db.insert(courierRecords).values({ driverId: d.id, kind: 'SUPPORT_NOTE', title: 'Reactivation requested', detail: note });
    return { lifecycleStatus: 'REACTIVATION_PENDING' };
  }

  // ───── admin: pipeline, checks, decisions, lifecycle ─────

  async pipeline(user: JwtPayload) {
    assertCan(user, 'delivery.read');
    const cfg = await this.recruitmentCfg();
    const counts = Object.fromEntries((await this.db.select({ s: drivers.applicationStatus, n: sql<number>`count(*)::int` }).from(drivers).groupBy(drivers.applicationStatus)).map((r) => [r.s, r.n]));
    const since = new Date(Date.now() - 90 * 86400_000);
    const [f] = await this.db.select({ started: sql<number>`count(*)::int`, submitted: sql<number>`count(*) filter (where ${drivers.submittedAt} is not null)::int`, approved: sql<number>`count(*) filter (where ${drivers.applicationStatus} = 'APPROVED')::int`, firstDelivery: sql<number>`count(*) filter (where ${drivers.firstDeliveryAt} is not null)::int` }).from(drivers).where(gte(drivers.createdAt, since));
    const list = await this.db.select({ d: drivers, name: users.name, email: users.email, emailVerifiedAt: users.emailVerifiedAt }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(ne(drivers.applicationStatus, 'APPROVED')).orderBy(desc(drivers.updatedAt)).limit(300);
    const ids = list.map((x) => x.d.id);
    const docs = ids.length ? await this.db.select().from(courierDocuments).where(inArray(courierDocuments.driverId, ids)) : [];
    const checks = ids.length ? await this.db.select().from(courierEligibility).where(inArray(courierEligibility.driverId, ids)) : [];
    const now = Date.now();
    return {
      counts, funnel: f,
      applicants: list.map(({ d, name, email, emailVerifiedAt }) => {
        const steps = this.steps(d, { emailVerifiedAt }, docs.filter((x) => x.driverId === d.id), checks.filter((x) => x.driverId === d.id), cfg);
        const stalled = (EDITABLE.includes(d.applicationStatus) && now - d.updatedAt.getTime() > 3 * 86400_000) || (d.applicationStatus === 'VERIFICATION_PENDING' && !!d.submittedAt && now - d.submittedAt.getTime() > 2 * 86400_000);
        return { id: d.id, name, email, city: d.city, transport: d.vehicleType, applicationStatus: d.applicationStatus, submittedAt: d.submittedAt, updatedAt: d.updatedAt, stalled, stepsDone: steps.filter((s) => s.done).length, stepsTotal: steps.length, checks: Object.fromEntries(ELIGIBILITY_CHECKS.map((c) => [c, checks.find((x) => x.driverId === d.id && x.check === c)?.status ?? 'NOT_STARTED'])), pendingDocs: docs.filter((x) => x.driverId === d.id && x.status === 'PENDING').length };
      }),
    };
  }

  async decideCheck(user: JwtPayload, driverId: string, check: string, b: { status: string; note?: string; expiresAt?: string }) {
    assertCan(user, 'delivery.manage');
    if (!(ELIGIBILITY_CHECKS as readonly string[]).includes(check)) throw new BadRequestException('Unknown check');
    if (['FAILED', 'NEEDS_ACTION'].includes(b.status) && !b.note) throw new BadRequestException('Say why, so the courier knows what to do');
    const d = await this.requireDriver(driverId);
    await this.setCheck(driverId, check as EligibilityCheck, b.status, { note: b.note ?? null, by: user.sub, expiresAt: b.expiresAt ? new Date(b.expiresAt) : undefined });
    if (b.status === 'NEEDS_ACTION' && ['SUBMITTED', 'VERIFICATION_PENDING'].includes(d.applicationStatus)) await this.db.update(drivers).set({ applicationStatus: 'NEEDS_ACTION', decisionNote: b.note ?? null }).where(eq(drivers.id, driverId));
    // an approved courier with a failed or reopened check stops receiving work until it is fixed
    if (['FAILED', 'NEEDS_ACTION', 'EXPIRED'].includes(b.status) && d.applicationStatus === 'APPROVED') await this.db.update(drivers).set({ isAvailable: false }).where(eq(drivers.id, driverId));
    if (check === 'EQUIPMENT' && b.status === 'PASSED') {
      const items = ((d.onboarding as Onb).equipment?.items ?? []);
      const caps = new Set(d.capabilities);
      if (items.includes('INSULATED_BAG')) caps.add('HOT_BAG');
      if (items.includes('COLD_BAG')) caps.add('COLD_BAG');
      await this.db.update(drivers).set({ capabilities: [...caps] }).where(eq(drivers.id, driverId));
    }
    await this.audit.log({ actorId: user.sub, action: 'courier.check', entityType: 'driver', entityId: driverId, after: { check, status: b.status, expiresAt: b.expiresAt }, reason: b.note });
    return this.onboardingView(d.userId, d.id);
  }

  async decide(user: JwtPayload, driverId: string, decision: 'APPROVE' | 'NEEDS_ACTION' | 'WAITLIST' | 'REJECT' | 'REOPEN', note: string) {
    assertCan(user, 'delivery.manage');
    const d = await this.requireDriver(driverId);
    const patch: Partial<typeof drivers.$inferInsert> = { decidedAt: new Date(), decidedById: user.sub, decisionNote: note };
    if (decision === 'APPROVE') {
      if (!['SUBMITTED', 'VERIFICATION_PENDING', 'NEEDS_ACTION', 'WAITLISTED'].includes(d.applicationStatus)) throw new ConflictException(`Application is ${d.applicationStatus}`);
      await this.syncDocChecks(driverId);
      const checks = await this.db.select().from(courierEligibility).where(eq(courierEligibility.driverId, driverId));
      const notPassed = ELIGIBILITY_CHECKS.filter((c) => { const r = checks.find((x) => x.check === c); return !r || r.status !== 'PASSED' || (r.expiresAt && r.expiresAt < new Date()); });
      const docs = await this.db.select().from(courierDocuments).where(and(eq(courierDocuments.driverId, driverId), eq(courierDocuments.status, 'APPROVED')));
      const missingDocs = requiredDocsFor(d.vehicleType).filter((k) => !docs.some((x) => x.kind === k && (!x.expiresAt || x.expiresAt > new Date())));
      if (notPassed.length || missingDocs.length) throw new BadRequestException({ message: `Not ready to approve: ${[...notPassed.map((c) => `${c.toLowerCase()} check`), ...missingDocs.map((k) => `${k.toLowerCase().replace('_', ' ')} document`)].join(', ')}`, code: 'CHECKS_INCOMPLETE', checks: notPassed, docs: missingDocs });
      Object.assign(patch, { applicationStatus: 'APPROVED', lifecycleStatus: 'ACTIVE', status: 'APPROVED', licenseVerified: true, suspendedReason: null, suspendedAt: null });
      await this.db.update(users).set({ roles: sql`array_append(array_remove(${users.roles}, 'DRIVER'), 'DRIVER')` }).where(eq(users.id, d.userId));
    } else if (decision === 'NEEDS_ACTION') {
      if (!['SUBMITTED', 'VERIFICATION_PENDING', 'WAITLISTED'].includes(d.applicationStatus)) throw new ConflictException(`Application is ${d.applicationStatus}`);
      patch.applicationStatus = 'NEEDS_ACTION';
    } else if (decision === 'WAITLIST') {
      if (d.applicationStatus === 'APPROVED') throw new ConflictException('Already approved');
      patch.applicationStatus = 'WAITLISTED';
    } else if (decision === 'REJECT') {
      if (d.applicationStatus === 'APPROVED') throw new ConflictException('Already approved; use the account status instead');
      patch.applicationStatus = 'REJECTED';
    } else {
      if (!['WAITLISTED', 'REJECTED'].includes(d.applicationStatus)) throw new ConflictException('Only a waitlisted or rejected application can be reopened');
      patch.applicationStatus = d.submittedAt ? 'VERIFICATION_PENDING' : 'DRAFT';
    }
    await this.db.update(drivers).set(patch).where(eq(drivers.id, driverId));
    await this.db.insert(courierRecords).values({ driverId, kind: 'SUPPORT_NOTE', title: `Application: ${String(patch.applicationStatus).toLowerCase().replace('_', ' ')}`, detail: note, createdById: user.sub });
    await this.audit.log({ actorId: user.sub, action: `courier.decision_${decision.toLowerCase()}`, entityType: 'driver', entityId: driverId, before: { applicationStatus: d.applicationStatus }, after: { applicationStatus: patch.applicationStatus }, reason: note });
    await this.outbox.publish('courier.decision', driverId, { userId: d.userId, applicationStatus: patch.applicationStatus, note });
    return this.onboardingView(d.userId, d.id);
  }

  /**
   * Legacy `POST /drivers/:id/approve` (staff override from Phase G): documents were checked there; record the decision on the
   * R1 application and mark every check PASSED by the approver, so the courier is dispatchable. Rejection rejects the application.
   */
  async legacyDecision(user: JwtPayload, driverId: string, approved: boolean) {
    if (!approved) {
      await this.db.update(drivers).set({ applicationStatus: 'REJECTED', decidedAt: new Date(), decidedById: user.sub, decisionNote: 'Not approved' }).where(eq(drivers.id, driverId));
      return;
    }
    for (const c of ELIGIBILITY_CHECKS) {
      const [cur] = await this.db.select().from(courierEligibility).where(and(eq(courierEligibility.driverId, driverId), eq(courierEligibility.check, c))).limit(1);
      if (cur?.status !== 'PASSED') await this.setCheck(driverId, c, 'PASSED', { note: 'Approved by staff override', by: user.sub });
    }
    await this.db.update(drivers).set({ applicationStatus: 'APPROVED', lifecycleStatus: 'ACTIVE', decidedAt: new Date(), decidedById: user.sub, decisionNote: 'Approved by staff override' }).where(eq(drivers.id, driverId));
  }

  /** Account lifecycle after approval. Suspension keeps the Phase G appeal flow; deactivation can be reversed only by a person. */
  async setLifecycle(user: JwtPayload, driverId: string, status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'DEACTIVATED', reason: string) {
    assertCan(user, 'delivery.manage');
    const d = await this.requireDriver(driverId);
    if (d.applicationStatus !== 'APPROVED') throw new ConflictException('Only an approved courier has an account status');
    if (d.lifecycleStatus === status) throw new ConflictException(`Already ${status.toLowerCase()}`);
    if (status === 'SUSPENDED' || status === 'DEACTIVATED') {
      const active = await this.db.select({ id: deliveryJobs.id }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, driverId), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
      if (active.length) throw new ConflictException(`Resolve the courier’s ${active.length} active deliver${active.length > 1 ? 'ies' : 'y'} first`);
      await this.db.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.driverId, driverId), eq(driverOffers.status, 'OFFERED')));
      await this.db.update(drivers).set({ status: 'SUSPENDED', lifecycleStatus: status, lifecycleReason: reason, isAvailable: false, suspendedReason: reason, suspendedAt: new Date(), suspendedById: user.sub, ...(status === 'SUSPENDED' ? { appealStatus: 'NONE', appealNote: null, appealDecisionNote: null, reviewedById: null } : {}) }).where(eq(drivers.id, driverId));
      await this.db.update(courierTimeEntries).set({ endedAt: new Date() }).where(and(eq(courierTimeEntries.driverId, driverId), isNull(courierTimeEntries.endedAt)));
    } else {
      // lifting a suspension is decided by someone other than the person who suspended
      if (d.lifecycleStatus === 'SUSPENDED' && d.suspendedById === user.sub) throw new ForbiddenException('Someone other than the person who suspended the courier must lift it');
      await this.db.update(drivers).set({ status: 'APPROVED', lifecycleStatus: status, lifecycleReason: reason, suspendedReason: null, ...(d.appealStatus === 'PENDING' ? { appealStatus: 'REINSTATED', appealDecisionNote: reason, reviewedById: user.sub } : {}) }).where(eq(drivers.id, driverId));
    }
    await this.db.insert(courierRecords).values({ driverId, kind: status === 'ACTIVE' ? 'SUPPORT_NOTE' : 'INCIDENT', title: `Account ${status.toLowerCase()}`, detail: reason, createdById: user.sub });
    await this.audit.log({ actorId: user.sub, action: `courier.lifecycle_${status.toLowerCase()}`, entityType: 'driver', entityId: driverId, before: { lifecycleStatus: d.lifecycleStatus }, after: { lifecycleStatus: status }, reason });
    return (await this.db.select().from(drivers).where(eq(drivers.id, driverId)))[0];
  }

  /** Extra courier-profile panels for staff: onboarding, time in the last 7 days, feedback; payout details masked without finance access. */
  async adminExtras(user: JwtPayload, driverId: string) {
    const d = await this.requireDriver(driverId);
    const since = new Date(Date.now() - 7 * 86400_000);
    return {
      onboarding: await this.onboardingView(d.userId, d.id),
      time: await this.timeSummary(d.id, since),
      feedback: await this.feedbackFor(d.id, true),
      payoutVisible: can(user, 'finance.read'),
    };
  }

  // ───── starting work ─────

  async timeSummary(driverId: string, since: Date) {
    const now = new Date();
    const entries = await this.db.select().from(courierTimeEntries).where(and(eq(courierTimeEntries.driverId, driverId), sql`coalesce(${courierTimeEntries.endedAt}, now()) >= ${since.toISOString()}`));
    const clip = (a: Date, b: Date | null) => mins(a < since ? since : a, b ?? now);
    const onlineMinutes = entries.filter((e) => e.kind === 'ONLINE').reduce((s, e) => s + clip(e.startedAt, e.endedAt), 0);
    const breakMinutes = entries.filter((e) => e.kind === 'BREAK').reduce((s, e) => s + clip(e.startedAt, e.endedAt), 0);
    const reservedMinutes = entries.filter((e) => e.kind === 'ONLINE' && e.mode === 'RESERVED').reduce((s, e) => s + clip(e.startedAt, e.endedAt), 0);
    const jobs = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.driverId, driverId), isNotNull(deliveryJobs.assignedAt), sql`coalesce(${deliveryJobs.deliveredAt}, ${deliveryJobs.canceledAt}, now()) >= ${since.toISOString()}`));
    const activeMinutes = jobs.reduce((s, j) => s + clip(j.assignedAt!, j.deliveredAt ?? j.canceledAt ?? (['ASSIGNED', 'PICKED_UP'].includes(j.status) ? null : j.updatedAt)), 0);
    const waitingMinutes = jobs.filter((j) => j.arrivedPickupAt).reduce((s, j) => s + clip(j.arrivedPickupAt!, j.pickedUpAt ?? (['ASSIGNED'].includes(j.status) ? null : j.updatedAt)), 0);
    const r = (x: number) => Math.round(x);
    return { onlineMinutes: r(onlineMinutes), breakMinutes: r(breakMinutes), reservedMinutes: r(reservedMinutes), activeMinutes: r(activeMinutes), waitingMinutes: r(waitingMinutes), deliveries: jobs.filter((j) => j.status === 'DELIVERED' && j.deliveredAt && j.deliveredAt >= since).length };
  }

  async status(user: JwtPayload) {
    const d = await this.delivery.myDriver(user);
    const acfg = await this.delivery.availabilityCfg();
    const [{ n: activeJobs }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
    const reasons: string[] = [];
    if (d.applicationStatus !== 'APPROVED') reasons.push('NOT_APPROVED');
    if (!['ACTIVE', 'RESTRICTED'].includes(d.lifecycleStatus ?? '')) reasons.push('LIFECYCLE');
    if ((await this.delivery.driversWithExpiredDocs(this.db)).has(d.id)) reasons.push('DOCS_EXPIRED');
    if ((await this.delivery.driversWithBadChecks(this.db)).has(d.id)) reasons.push('CHECK_EXPIRED');
    if (!d.isAvailable) reasons.push('OFFLINE');
    if (d.onBreak) reasons.push('ON_BREAK');
    if (d.finishAfterCurrent) reasons.push('FINISHING');
    if (d.isAvailable && (d.lastLat === null || !d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > acfg.locationFreshMinutes * 60_000)) reasons.push('NO_LOCATION');
    if (activeJobs >= d.maxConcurrent) reasons.push('AT_CAPACITY');
    const [open] = await this.db.select().from(courierTimeEntries).where(and(eq(courierTimeEntries.driverId, d.id), eq(courierTimeEntries.kind, 'ONLINE'), isNull(courierTimeEntries.endedAt))).limit(1);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const t = await this.timeSummary(d.id, dayStart);
    const [{ cents }] = await this.db.select({ cents: sql<number>`coalesce(sum(${driverEarnings.baseCents} + ${driverEarnings.distanceCents} + ${driverEarnings.timeCents} + ${driverEarnings.waitingCents} + ${driverEarnings.returnCents} + ${driverEarnings.tipCents} + ${driverEarnings.bonusCents}), 0)::int` }).from(driverEarnings).where(and(eq(driverEarnings.driverId, d.id), gte(driverEarnings.createdAt, dayStart)));
    return { dispatchable: reasons.length === 0, reasons, isAvailable: d.isAvailable, mode: d.availabilityMode, onBreak: d.onBreak, finishAfterCurrent: d.finishAfterCurrent, onlineSince: open?.startedAt ?? null, activeJobs, firstDeliveryAt: d.firstDeliveryAt, lifecycleStatus: d.lifecycleStatus, applicationStatus: d.applicationStatus, today: { onlineMinutes: t.onlineMinutes, breakMinutes: t.breakMinutes, activeMinutes: t.activeMinutes, waitingMinutes: t.waitingMinutes, deliveries: t.deliveries, earningsCents: cents } };
  }

  async setBreak(user: JwtPayload, on: boolean) {
    const d = await this.delivery.myDriver(user);
    if (on && !d.isAvailable) throw new ConflictException('Go online first');
    if (on === d.onBreak) return this.status(user);
    await this.db.update(drivers).set({ onBreak: on }).where(eq(drivers.id, d.id));
    if (on) await this.db.insert(courierTimeEntries).values({ driverId: d.id, kind: 'BREAK', startedAt: new Date() });
    else await this.db.update(courierTimeEntries).set({ endedAt: new Date() }).where(and(eq(courierTimeEntries.driverId, d.id), eq(courierTimeEntries.kind, 'BREAK'), isNull(courierTimeEntries.endedAt)));
    return this.status(user);
  }

  async setFinishAfterCurrent(user: JwtPayload, on: boolean) {
    const d = await this.delivery.myDriver(user);
    await this.db.update(drivers).set({ finishAfterCurrent: on }).where(eq(drivers.id, d.id));
    if (on) {
      await this.db.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.driverId, d.id), eq(driverOffers.status, 'OFFERED')));
      await this.delivery.afterJobClosed(d.id, this.db);
    }
    return this.status(user);
  }

  /** Reserved availability: check in to a booked shift (from a little before it starts until it ends) and go online. */
  async checkIn(user: JwtPayload, shiftId: string, lat: number, lng: number) {
    const d = await this.delivery.myDriver(user);
    const [s] = await this.db.select().from(courierShifts).where(and(eq(courierShifts.id, shiftId), eq(courierShifts.driverId, d.id))).limit(1);
    if (!s) throw new NotFoundException();
    if (s.status === 'CHECKED_IN') return s;
    if (s.status !== 'SCHEDULED') throw new ConflictException(`Shift is ${s.status.toLowerCase().replace('_', ' ')}`);
    const acfg = await this.delivery.availabilityCfg();
    const now = Date.now();
    if (now < s.startsAt.getTime() - acfg.checkInEarlyMinutes * 60_000 || now > s.endsAt.getTime()) throw new ConflictException({ message: `You can check in from ${acfg.checkInEarlyMinutes} minutes before the shift starts until it ends`, code: 'OUTSIDE_SHIFT' });
    await this.delivery.setAvailability(user, true, lat, lng, 'RESERVED', s.id);
    const [u] = await this.db.update(courierShifts).set({ status: 'CHECKED_IN', checkedInAt: new Date() }).where(eq(courierShifts.id, s.id)).returning();
    return u;
  }

  /** Shifts nobody checked in to become NO_SHOW (worker). */
  async markNoShows(now = new Date()) {
    const acfg = await this.delivery.availabilityCfg();
    const late = await this.db.update(courierShifts).set({ status: 'NO_SHOW' }).where(and(eq(courierShifts.status, 'SCHEDULED'), lt(courierShifts.startsAt, new Date(now.getTime() - acfg.noShowAfterMinutes * 60_000)))).returning();
    for (const s of late) await this.db.insert(courierRecords).values({ driverId: s.driverId, kind: 'SUPPORT_NOTE', title: 'Missed shift check-in', detail: `Shift ${s.startsAt.toISOString()} – ${s.endsAt.toISOString()}` });
    return late.length;
  }

  // ───── trip problems ─────

  private async myJob(user: JwtPayload, jobId: string) {
    const d = await this.delivery.myDriver(user);
    const [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.driverId, d.id))).limit(1);
    if (!job) throw new NotFoundException();
    return { d, job };
  }

  /** Give a delivery back before pickup: the assignment is released (history kept) and the job is offered again. */
  async release(user: JwtPayload, jobId: string, reason: string) {
    const { d, job } = await this.myJob(user, jobId);
    if (job.status !== 'ASSIGNED') throw new ConflictException({ message: job.status === 'PICKED_UP' ? 'You have the food: report “I can’t continue” instead' : `Delivery is ${job.status}`, code: 'AFTER_PICKUP' });
    return this.db.transaction(async (tx) => this.releaseJob(tx, job, d.id, reason));
  }

  private async releaseJob(tx: DbOrTx, job: Job, driverId: string, reason: string) {
    await tx.update(deliveryJobs).set({ driverId: null, status: 'REQUESTED', batchId: null, payPolicy: null, arrivedPickupAt: null, assignedAt: null }).where(eq(deliveryJobs.id, job.id));
    await tx.update(driverOffers).set({ status: 'RELEASED', respondedAt: new Date() }).where(and(eq(driverOffers.deliveryJobId, job.id), eq(driverOffers.driverId, driverId), eq(driverOffers.status, 'ACCEPTED')));
    await this.delivery.event(job.id, 'DRIVER_RELEASED', { driverId, reason }, tx);
    await tx.insert(courierRecords).values({ driverId, kind: 'SUPPORT_NOTE', title: 'Released a delivery before pickup', detail: reason });
    await this.delivery.afterJobClosed(driverId, tx);
    const [fresh] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id));
    await this.delivery.offerRound(fresh, tx);
    const [after] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id));
    return { ok: true, jobStatus: after.status };
  }

  private async raise(tx: DbOrTx, job: Job, reporterId: string, b: { category: string; description: string; priority: string; queue: string; owner: string }) {
    const [o] = job.orderId ? await tx.select({ org: orders.organizationId }).from(orders).where(eq(orders.id, job.orderId)).limit(1) : [null];
    const [loc] = await tx.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    const [inc] = await tx.insert(incidents).values({ orderId: job.orderId, deliveryJobId: job.id, organizationId: o?.org ?? loc?.org ?? null, reporterType: 'DRIVER', reporterId, category: b.category, description: b.description, priority: b.priority, queue: b.queue, owner: b.owner }).returning();
    return inc;
  }

  private async alert(tx: DbOrTx, job: Job, kind: string, severity: string, title: string, detail: string) {
    const [loc] = await tx.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    await tx.insert(opsAlerts).values({ type: 'MANUAL', severity, title, detail, subjectType: 'delivery_job', subjectId: job.id, organizationId: loc?.org ?? null, locationId: job.locationId, dedupeKey: `courier-issue:${job.id}:${kind}`, ownerRole: 'DISPATCHER', escalateAt: new Date(Date.now() + 10 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: detail }] }).onConflictDoNothing();
  }

  async issue(user: JwtPayload, jobId: string, b: { kind: TripIssue; note?: string; photoUrl?: string }) {
    const { d, job } = await this.myJob(user, jobId);
    const meta = TRIP_ISSUES[b.kind];
    if (!meta) throw new BadRequestException('Unknown problem');
    if (!['ASSIGNED', 'PICKED_UP'].includes(job.status)) throw new ConflictException(`Delivery is ${job.status}`);
    if (meta.stage === 'PICKUP' && job.status !== 'ASSIGNED') throw new ConflictException('You already picked this order up');
    if (meta.stage === 'DROPOFF' && job.status !== 'PICKED_UP') throw new ConflictException('Pick the order up first');
    const policy = (await this.delivery.jobPay(job)).policy;
    const note = b.note?.slice(0, 500);
    return this.db.transaction(async (tx) => {
      let outcome = '';
      let incidentId: string | undefined;
      const now = new Date();
      const markArrived = async () => { if (!job.arrivedPickupAt) { await tx.update(deliveryJobs).set({ arrivedPickupAt: now }).where(eq(deliveryJobs.id, job.id)); job.arrivedPickupAt = now; } };
      switch (b.kind) {
        case 'ORDER_NOT_READY': {
          await markArrived();
          await this.delivery.event(job.id, 'KITCHEN_DELAY', { driverId: d.id, note }, tx);
          await this.outbox.publish('delivery.issue', job.id, { orderId: job.orderId, kind: b.kind, locationId: job.locationId }, tx);
          outcome = `The kitchen knows you’re waiting. Waiting after ${policy.waitingGraceMinutes} minutes is paid at ${(policy.waitingPerMinuteCents / 100).toFixed(2)} per minute.`;
          break;
        }
        case 'MISSING_ITEMS':
        case 'DAMAGED_PACKAGING': {
          await markArrived();
          const inc = await this.raise(tx, job, user.sub, { category: b.kind === 'MISSING_ITEMS' ? 'MISSING_ITEM' : 'DAMAGED', description: `Courier at pickup: ${meta.label}${note ? ` — ${note}` : ''}`, priority: 'HIGH', queue: 'DELIVERY', owner: 'MERCHANT' });
          incidentId = inc.id;
          await this.outbox.publish('delivery.issue', job.id, { orderId: job.orderId, kind: b.kind, locationId: job.locationId }, tx);
          outcome = 'The kitchen has been asked to fix it. Don’t leave until it’s sorted, then confirm pickup.';
          break;
        }
        case 'RESTAURANT_CLOSED': {
          await markArrived();
          const inc = await this.raise(tx, job, user.sub, { category: 'RESTAURANT_CLOSED', description: `Courier found the pickup closed${note ? ` — ${note}` : ''}`, priority: 'HIGH', queue: 'DELIVERY', owner: 'MERCHANT' });
          incidentId = inc.id;
          await this.alert(tx, job, b.kind, 'HIGH', 'Pickup closed', 'A courier found the kitchen closed. Contact the kitchen, then remake, reschedule or cancel the order.');
          await this.delivery.transition(job.id, 'CANCELED', { reason: 'Restaurant closed at pickup', costOwner: 'MERCHANT' }, tx);
          outcome = `This trip is canceled. You’ll get ${(policy.cancelAfterArrivalCents / 100).toFixed(2)} cancellation pay.`;
          break;
        }
        case 'ALREADY_COLLECTED': {
          await markArrived();
          const inc = await this.raise(tx, job, user.sub, { category: 'ALREADY_COLLECTED', description: `Kitchen says the order was already collected${note ? ` — ${note}` : ''}`, priority: 'HIGH', queue: 'DELIVERY', owner: 'PLATFORM' });
          incidentId = inc.id;
          await this.alert(tx, job, b.kind, 'HIGH', 'Order already collected', 'The kitchen says someone already collected this order. Check the pickup history, decide on a remake, and re-dispatch or cancel.');
          await this.delivery.courierPay({ ...job, arrivedPickupAt: job.arrivedPickupAt ?? now, cancelReason: 'Order already collected' }, 'CANCELED', tx);
          await tx.update(deliveryJobs).set({ driverId: null, status: 'UNASSIGNED', payPolicy: null, cancelReason: 'Order already collected — investigate' }).where(eq(deliveryJobs.id, job.id));
          await this.delivery.event(job.id, 'ALREADY_COLLECTED', { driverId: d.id, note }, tx);
          await this.delivery.afterJobClosed(d.id, tx);
          outcome = 'Thanks. Operations will investigate; you’re free for other work and get cancellation pay.';
          break;
        }
        case 'VEHICLE_BREAKDOWN':
        case 'CANNOT_CONTINUE':
        case 'UNSAFE': {
          const safety = b.kind === 'UNSAFE';
          if (job.status === 'ASSIGNED') {
            if (safety) { const inc = await this.raise(tx, job, user.sub, { category: 'SAFETY', description: `Courier reported an unsafe situation before pickup${note ? ` — ${note}` : ''}`, priority: 'URGENT', queue: 'DELIVERY', owner: 'PLATFORM' }); incidentId = inc.id; }
            await this.releaseJob(tx, job, d.id, `${meta.label}${note ? `: ${note}` : ''}`);
            outcome = safety ? 'Leave the area if you can. The delivery has been given to someone else and our safety team will contact you.' : 'No problem: the delivery has been offered to another courier.';
            break;
          }
          // the food is with the courier: never reassign silently; operations decides on custody, the customer and a replacement
          const inc = await this.raise(tx, job, user.sub, { category: safety ? 'SAFETY' : 'COURIER_CANNOT_CONTINUE', description: `${meta.label} after pickup${note ? ` — ${note}` : ''}`, priority: 'URGENT', queue: 'DELIVERY', owner: 'PLATFORM' });
          incidentId = inc.id;
          await this.alert(tx, job, b.kind, 'CRITICAL', safety ? 'Courier safety report with food on board' : 'Courier can’t continue with food on board', 'Contact the courier, decide what happens to the food (return or dispose), tell the customer and arrange a replacement if needed.');
          const ex = { kind: b.kind, attempts: [{ at: now.toISOString(), method: 'APP', note }], waitUntil: now.toISOString() };
          await tx.update(deliveryJobs).set({ exception: ex }).where(eq(deliveryJobs.id, job.id));
          await this.outbox.publish('delivery.late', job.id, { orderId: job.orderId, reason: b.kind }, tx);
          outcome = safety ? 'Get somewhere safe. Our team will call you; don’t hand the food to anyone.' : 'Stay where you are if it’s safe. Operations will contact you about the food; don’t hand it to anyone else.';
          break;
        }
        case 'ID_CHECK_FAILED': {
          if (!job.requirements.includes('ALCOHOL')) throw new BadRequestException('This order has no restricted items');
          await this.delivery.transition(job.id, 'RETURNED', { reason: 'ID check failed: restricted items returned', costOwner: 'CUSTOMER' }, tx);
          outcome = `Don’t hand over the restricted items. Return the order to the kitchen; you’ll get ${(policy.returnCents / 100).toFixed(2)} return pay.`;
          break;
        }
      }
      const [cur] = await tx.select({ issues: deliveryJobs.issues }).from(deliveryJobs).where(eq(deliveryJobs.id, job.id));
      await tx.update(deliveryJobs).set({ issues: [...((cur.issues as unknown[]) || []), { kind: b.kind, note: note ?? null, photoUrl: b.photoUrl ?? null, at: now.toISOString(), incidentId: incidentId ?? null, outcome }] }).where(eq(deliveryJobs.id, job.id));
      await this.delivery.event(job.id, `ISSUE_${b.kind}`, { driverId: d.id, incidentId }, tx);
      const [after] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id));
      return { job: { ...after, handoffPin: undefined }, outcome, incidentId };
    });
  }

  // ───── earnings ─────

  async earnings(user: JwtPayload) {
    const d = await this.delivery.myDriver(user);
    const policy = await this.delivery.payPolicy();
    const rows = await this.db.select().from(driverEarnings).where(eq(driverEarnings.driverId, d.id)).orderBy(desc(driverEarnings.createdAt)).limit(300);
    const now = new Date();
    const total = (e: typeof rows[number]) => e.baseCents + e.distanceCents + e.timeCents + e.waitingCents + e.returnCents + e.tipCents + e.bonusCents;
    const payable = await this.ledger.balance('DRIVER_PAYABLE', d.id);
    const pending = rows.filter((e) => e.availableAt && e.availableAt > now).reduce((s, e) => s + total(e), 0);
    const day = (x: Date) => x.toISOString().slice(0, 10);
    const monday = (x: Date) => { const t = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return day(t); };
    const group = (key: (x: Date) => string, limit: number) => {
      const m = new Map<string, { cents: number; deliveries: number }>();
      for (const e of rows) { const k = key(e.createdAt); const g = m.get(k) || { cents: 0, deliveries: 0 }; g.cents += total(e); if (e.kind === 'DELIVERY') g.deliveries++; m.set(k, g); }
      return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, limit);
    };
    const pays = await this.db.select().from(payouts).where(and(eq(payouts.partyType, 'DRIVER'), eq(payouts.partyId, d.id))).orderBy(desc(payouts.createdAt)).limit(30);
    const ob = d.onboarding as Onb;
    return {
      payableCents: payable, pendingCents: pending, availableCents: Math.max(0, payable - pending),
      policy,
      entries: rows.map((e) => ({ id: e.id, kind: e.kind, deliveryJobId: e.deliveryJobId, baseCents: e.baseCents, distanceCents: e.distanceCents, timeCents: e.timeCents, waitingCents: e.waitingCents, returnCents: e.returnCents, tipCents: e.tipCents, bonusCents: e.bonusCents, totalCents: total(e), reason: e.reason, policyVersion: e.policyVersion, availableAt: e.availableAt, createdAt: e.createdAt })),
      days: group(day, 14).map(([date, g]) => ({ date, ...g })),
      weeks: group(monday, 8).map(([weekStart, g]) => ({ weekStart, ...g })),
      payouts: pays.map((p) => ({ id: p.id, amountCents: p.amountCents, status: p.status, failureReason: p.failureReason, periodStart: p.periodStart, periodEnd: p.periodEnd, paidAt: p.paidAt })),
      payoutAccount: ob.payout ? { method: ob.payout.method, accountLast4: ob.payout.accountLast4 } : d.payoutAccountId ? { method: 'BANK', accountLast4: d.payoutAccountId.slice(-4) } : null,
    };
  }

  async disputeEarnings(user: JwtPayload, b: { deliveryJobId?: string; note: string }) {
    const d = await this.delivery.myDriver(user);
    let job: Job | null = null;
    if (b.deliveryJobId) {
      [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, b.deliveryJobId), eq(deliveryJobs.driverId, d.id))).limit(1);
      if (!job) throw new NotFoundException('That delivery isn’t one of yours');
    }
    const [inc] = await this.db.insert(incidents).values({ orderId: job?.orderId ?? null, deliveryJobId: job?.id ?? null, reporterType: 'DRIVER', reporterId: user.sub, category: 'EARNINGS_DISPUTE', description: b.note, priority: 'NORMAL', queue: 'FINANCE', owner: 'PLATFORM' }).returning();
    await this.db.insert(courierRecords).values({ driverId: d.id, kind: 'SUPPORT_NOTE', title: 'Earnings question', detail: b.note });
    return { incidentId: inc.id, status: inc.status };
  }

  // ───── delivery reviews ─────

  private async orderJob(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o || o.userId !== user.sub) throw new NotFoundException('Order not found');
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    return { o, job: job ?? null };
  }

  private async firstName(driverId: string | null) {
    if (!driverId) return null;
    const [r] = await this.db.select({ name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, driverId)).limit(1);
    return r?.name?.split(' ')[0] ?? null;
  }

  async reviewState(user: JwtPayload, orderId: string) {
    const { job } = await this.orderJob(user, orderId);
    const [review] = job ? await this.db.select().from(deliveryReviews).where(and(eq(deliveryReviews.deliveryJobId, job.id), eq(deliveryReviews.customerId, user.sub))).limit(1) : [];
    const reason = !job ? 'Not a delivery order' : job.status !== 'DELIVERED' ? 'You can rate the delivery once it arrives' : null;
    const editableUntil = review ? new Date(review.createdAt.getTime() + REVIEW_EDIT_DAYS * 86400_000) : null;
    return { eligible: !reason && (!review || editableUntil! > new Date()), reason, courierFirstName: await this.firstName(job?.driverId ?? null), review: review ? this.customerReview(review) : null, editableUntil };
  }

  private customerReview(r: typeof deliveryReviews.$inferSelect) {
    return { id: r.id, rating: r.rating, tags: r.tags, comment: r.comment, foodRating: r.foodRating, packagingRating: r.packagingRating, issues: r.issues, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  /** Mask contact details, hold abusive text for moderation. */
  private moderate(comment: string | undefined) {
    if (!comment?.trim()) return { comment: null, status: 'VISIBLE' };
    const masked = comment.trim().slice(0, 1000).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]').replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[number removed]');
    return { comment: masked, status: BLOCKLIST.test(masked) ? 'PENDING_MODERATION' : 'VISIBLE' };
  }

  async submitReview(user: JwtPayload, orderId: string, b: { rating: number; tags?: string[]; comment?: string; foodRating?: number; packagingRating?: number; issues?: ReviewIssue[] }) {
    const { o, job } = await this.orderJob(user, orderId);
    if (!job) throw new BadRequestException('Not a delivery order');
    if (job.status !== 'DELIVERED') throw new ConflictException({ message: 'You can rate the delivery once it arrives', code: 'NOT_DELIVERED' });
    const allowed = new Set<string>([...REVIEW_TAGS_POSITIVE, ...REVIEW_TAGS_NEGATIVE]);
    const tags = Array.from(new Set((b.tags ?? []).filter((t) => allowed.has(t))));
    const issues = Array.from(new Set((b.issues ?? []).filter((i) => i in REVIEW_ISSUES)));
    const m = this.moderate(b.comment);
    // attribution: kitchen delays and sealed-bag preparation errors are not the courier's fault
    const policy = (await this.delivery.jobPay(job)).policy;
    const waitMinutes = job.arrivedPickupAt && job.pickedUpAt ? mins(job.arrivedPickupAt, job.pickedUpAt) : null;
    const courierNeg = tags.filter((t) => (REVIEW_TAGS_NEGATIVE as readonly string[]).includes(t) && t !== 'LATE');
    const seal = (job.pickupCheck as { sealIntact?: boolean } | null)?.sealIntact === true;
    let excludedReason: string | null = null;
    if (b.rating <= 3 && !courierNeg.length) {
      if (waitMinutes !== null && waitMinutes > policy.waitingGraceMinutes + 5 && (tags.includes('LATE') || !tags.length)) excludedReason = 'KITCHEN_DELAY';
      else if (seal && issues.length && issues.every((i) => i === 'MISSING_ITEMS' || i === 'DAMAGED') && !tags.length) excludedReason = 'SEALED_BAG';
    }
    if (!job.driverId) excludedReason = excludedReason ?? 'PARTNER_COURIER';
    const [existing] = await this.db.select().from(deliveryReviews).where(and(eq(deliveryReviews.deliveryJobId, job.id), eq(deliveryReviews.customerId, user.sub))).limit(1);
    if (existing && existing.createdAt.getTime() + REVIEW_EDIT_DAYS * 86400_000 < Date.now()) throw new ConflictException({ message: 'This review can no longer be changed', code: 'REVIEW_LOCKED' });
    const newIssues = issues.filter((i) => !existing?.issues.includes(i));
    return this.db.transaction(async (tx) => {
      const incidentIds: string[] = [...(existing?.incidentIds ?? [])];
      const map: Record<string, { category: string; priority: string; queue: string; owner: string }> = {
        MISSING_ITEMS: { category: 'MISSING_ITEM', priority: 'NORMAL', queue: 'SUPPORT', owner: 'MERCHANT' },
        NOT_RECEIVED: { category: 'NO_HANDOFF', priority: 'HIGH', queue: 'DELIVERY', owner: 'PLATFORM' },
        DAMAGED: { category: 'DAMAGED', priority: 'NORMAL', queue: 'SUPPORT', owner: seal ? 'MERCHANT' : 'PLATFORM' },
        SAFETY: { category: 'SAFETY', priority: 'URGENT', queue: 'DELIVERY', owner: 'PLATFORM' },
      };
      for (const i of newIssues) {
        const [inc] = await tx.insert(incidents).values({ orderId: o.id, deliveryJobId: job.id, organizationId: o.organizationId, reporterType: 'CUSTOMER', reporterId: user.sub, description: `From the delivery review: ${REVIEW_ISSUES[i as ReviewIssue]}${m.comment ? ` — ${m.comment}` : ''}`, ...map[i] }).returning();
        incidentIds.push(inc.id);
      }
      const values = { rating: b.rating, tags, comment: m.comment, foodRating: b.foodRating ?? null, packagingRating: b.packagingRating ?? null, issues, status: m.status, excluded: !!excludedReason, excludedReason, incidentIds, waitMinutes };
      let r: typeof deliveryReviews.$inferSelect;
      if (existing) {
        const hist = [...((existing.history as unknown[]) || []), { at: new Date().toISOString(), by: user.sub, action: 'EDIT', before: { rating: existing.rating, tags: existing.tags, comment: existing.comment } }];
        [r] = await tx.update(deliveryReviews).set({ ...values, history: hist, updatedAt: new Date() }).where(eq(deliveryReviews.id, existing.id)).returning();
      } else {
        [r] = await tx.insert(deliveryReviews).values({ ...values, deliveryJobId: job.id, orderId: o.id, customerId: user.sub, driverId: job.driverId, history: [{ at: new Date().toISOString(), by: user.sub, action: 'CREATE' }] }).returning();
      }
      if (job.driverId) await this.recomputeRating(job.driverId, tx);
      return this.customerReview(r);
    });
  }

  async recomputeRating(driverId: string, tx: DbOrTx = this.db) {
    const [a] = await tx.select({ avg: sql<number | null>`avg(${deliveryReviews.rating})::float`, n: sql<number>`count(*)::int` }).from(deliveryReviews).where(and(eq(deliveryReviews.driverId, driverId), eq(deliveryReviews.excluded, false)));
    await tx.update(drivers).set({ ratingAvg: a.avg === null ? null : Math.round(a.avg * 100) / 100, ratingCount: a.n }).where(eq(drivers.id, driverId));
  }

  /** The courier's view: no customer identity; held or hidden comments are not shown. */
  async feedbackFor(driverId: string, staff = false) {
    const [d] = await this.db.select({ avg: drivers.ratingAvg, n: drivers.ratingCount }).from(drivers).where(eq(drivers.id, driverId)).limit(1);
    const rs = await this.db.select().from(deliveryReviews).where(eq(deliveryReviews.driverId, driverId)).orderBy(desc(deliveryReviews.createdAt)).limit(100);
    const tagCounts: Record<string, number> = {};
    for (const r of rs) if (!r.excluded) for (const t of r.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    return { ratingAvg: d?.avg ?? null, ratingCount: d?.n ?? 0, tagCounts, recent: rs.slice(0, 20).map((r) => ({ id: r.id, rating: r.rating, tags: r.tags, comment: r.status === 'VISIBLE' || staff ? r.comment : null, createdAt: r.createdAt, excluded: r.excluded, excludedReason: r.excludedReason, disputeStatus: r.disputeStatus, ...(staff ? { status: r.status, orderId: r.orderId, deliveryJobId: r.deliveryJobId } : {}) })) };
  }

  async myFeedback(user: JwtPayload) { const d = await this.delivery.myDriver(user); return this.feedbackFor(d.id); }

  async disputeReview(user: JwtPayload, reviewId: string, note: string) {
    const d = await this.delivery.myDriver(user);
    const [r] = await this.db.select().from(deliveryReviews).where(and(eq(deliveryReviews.id, reviewId), eq(deliveryReviews.driverId, d.id))).limit(1);
    if (!r) throw new NotFoundException();
    if (r.disputeStatus !== 'NONE') throw new ConflictException('This review has already been disputed');
    const [u] = await this.db.update(deliveryReviews).set({ disputeStatus: 'PENDING', disputeNote: note, history: [...((r.history as unknown[]) || []), { at: new Date().toISOString(), by: user.sub, action: 'DISPUTE', note }] }).where(eq(deliveryReviews.id, r.id)).returning();
    return { id: u.id, disputeStatus: u.disputeStatus };
  }

  async adminReviews(user: JwtPayload, status = 'ALL') {
    assertCan(user, 'delivery.read', 'support.read');
    const where = status === 'PENDING_MODERATION' ? eq(deliveryReviews.status, 'PENDING_MODERATION') : status === 'DISPUTED' ? eq(deliveryReviews.disputeStatus, 'PENDING') : sql`true`;
    const rows = await this.db.select({ r: deliveryReviews, driverName: users.name }).from(deliveryReviews).leftJoin(drivers, eq(drivers.id, deliveryReviews.driverId)).leftJoin(users, eq(users.id, drivers.userId)).where(where).orderBy(desc(deliveryReviews.createdAt)).limit(200);
    return rows.map(({ r, driverName }) => ({ id: r.id, deliveryJobId: r.deliveryJobId, orderId: r.orderId, driverId: r.driverId, driverName, rating: r.rating, tags: r.tags, comment: r.comment, foodRating: r.foodRating, packagingRating: r.packagingRating, issues: r.issues, status: r.status, excluded: r.excluded, excludedReason: r.excludedReason, disputeStatus: r.disputeStatus, disputeNote: r.disputeNote, waitMinutes: r.waitMinutes, history: r.history, createdAt: r.createdAt }));
  }

  async moderateReview(user: JwtPayload, id: string, action: 'APPROVE' | 'HIDE' | 'EXCLUDE' | 'RESTORE' | 'UPHOLD_DISPUTE' | 'REJECT_DISPUTE', note: string) {
    assertCan(user, 'delivery.manage', 'support.manage');
    const [r] = await this.db.select().from(deliveryReviews).where(eq(deliveryReviews.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    const patch: Partial<typeof deliveryReviews.$inferInsert> = {};
    if (action === 'APPROVE') patch.status = 'VISIBLE';
    if (action === 'HIDE') patch.status = 'HIDDEN';
    if (action === 'EXCLUDE') Object.assign(patch, { excluded: true, excludedReason: 'MODERATION' });
    if (action === 'RESTORE') Object.assign(patch, { excluded: false, excludedReason: null, status: 'VISIBLE' });
    if (action === 'UPHOLD_DISPUTE' || action === 'REJECT_DISPUTE') {
      if (r.disputeStatus !== 'PENDING') throw new ConflictException('No dispute waiting');
      Object.assign(patch, action === 'UPHOLD_DISPUTE' ? { disputeStatus: 'UPHELD', excluded: true, excludedReason: 'DISPUTE_UPHELD' } : { disputeStatus: 'REJECTED' });
    }
    const [u] = await this.db.update(deliveryReviews).set({ ...patch, history: [...((r.history as unknown[]) || []), { at: new Date().toISOString(), by: user.sub, action, note, before: { status: r.status, excluded: r.excluded, disputeStatus: r.disputeStatus } }], updatedAt: new Date() }).where(eq(deliveryReviews.id, id)).returning();
    if (r.driverId) await this.recomputeRating(r.driverId);
    await this.audit.log({ actorId: user.sub, action: `delivery_review.${action.toLowerCase()}`, entityType: 'delivery_review', entityId: id, reason: note });
    return u;
  }

  /** Eligibility checks with an expiry date turn EXPIRED; the courier goes offline until fixed (worker). */
  async expireChecks(now = new Date()) {
    const exp = await this.db.update(courierEligibility).set({ status: 'EXPIRED', note: 'Expired; renew to keep delivering' }).where(and(eq(courierEligibility.status, 'PASSED'), lt(courierEligibility.expiresAt, now))).returning();
    const ids = Array.from(new Set(exp.map((e) => e.driverId)));
    if (ids.length) await this.db.update(drivers).set({ isAvailable: false }).where(inArray(drivers.id, ids));
    return { expired: exp.length };
  }
}
