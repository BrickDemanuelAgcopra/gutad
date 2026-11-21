import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  ageOn, CATEGORY_TRAINING, CERTIFIABLE_CATEGORIES, NO_BATCH_CATEGORIES, recipientMatches, REFUSAL_LABELS, SPECIAL_CATEGORIES, SPECIAL_CATEGORY_LABELS, specialConfig,
  type CertifiableCategory, type CustomerHandoffRequirements, type HandoffRequirements, type RefusalReason, type SpecialCategoriesConfig, type SpecialCategory, type SpecialRecord,
} from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { courierCertifications, courierEligibility, courierFraudCases, deliveryEvents, deliveryJobs, driverEarnings, drivers, groupOrders, incidents, locations, menuItems, opsAlerts, orderLines, orders, storedFiles, users } from '../../db/schema';
import { SettingsService } from '../../core/settings.service';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { storedFileId, viewableUrl } from './file-links';
import { DeliveryService } from './delivery.service';

type Job = typeof deliveryJobs.$inferSelect;
type Driver = typeof drivers.$inferSelect;
export interface SpecialPremium { category: SpecialCategory; label: string; cents: number }
export interface DispatchCtx { cfg: SpecialCategoriesConfig; delivered: Map<string, number>; openCases: Set<string> }

const special = (j: Job) => (j.special ?? {}) as SpecialRecord;
const cats = (reqs: string[]) => reqs.filter((r): r is SpecialCategory => (SPECIAL_CATEGORIES as readonly string[]).includes(r));
const minutes = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);

/**
 * Courier Release 4: specialised categories — alcohol / age-restricted, catering, pharmacy / sensitive,
 * temperature-controlled and high-value. Categories are computed with the R1 requirements, gate dispatch through
 * certifications (or tenure for high value), add a premium to the pay, and add rules to the handoff.
 */
@Injectable()
export class CourierSpecialService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async cfg(): Promise<SpecialCategoriesConfig> {
    return specialConfig(await this.settings.getObject<Partial<SpecialCategoriesConfig>>('delivery.special', {}));
  }

  /** the delivery service, resolved lazily (it depends on this service) */
  private get delivery(): DeliveryService {
    return this.moduleRef.get(DeliveryService, { strict: false });
  }

  // ───── categories ─────

  /** Categories an order needs, on top of the R1 requirements (ALCOHOL is already among those). */
  async categoriesFor(orderId: string | null, tx: DbOrTx, cfg?: SpecialCategoriesConfig): Promise<SpecialCategory[]> {
    if (!orderId) return [];
    const c = cfg ?? await this.cfg();
    const ls = await tx.select({ q: orderLines.quantity, handling: orderLines.handling, itemHandling: menuItems.handling, tax: menuItems.taxCategory }).from(orderLines).leftJoin(menuItems, eq(menuItems.id, orderLines.menuItemId)).where(eq(orderLines.orderId, orderId));
    const [o] = await tx.select({ sub: orders.subtotalCents, groupOrderId: orders.groupOrderId }).from(orders).where(eq(orders.id, orderId)).limit(1);
    const flag = (f: string) => ls.some((l) => l.handling?.includes(f) || l.itemHandling?.includes(f));
    const out: SpecialCategory[] = [];
    if (ls.some((l) => l.tax === 'ALCOHOL')) out.push('ALCOHOL');
    let catering = (o?.sub ?? 0) >= c.catering.minSubtotalCents || ls.reduce((a, l) => a + l.q, 0) >= c.catering.minItems;
    if (!catering && o?.groupOrderId) {
      const [g] = await tx.select({ mode: groupOrders.mode }).from(groupOrders).where(eq(groupOrders.id, o.groupOrderId)).limit(1);
      catering = g?.mode === 'CATERING_TRAYS';
    }
    if (catering) out.push('CATERING');
    if (flag('SENSITIVE')) out.push('SENSITIVE');
    if (flag('TEMP_CONTROLLED')) out.push('TEMP_CONTROLLED');
    if ((o?.sub ?? 0) >= c.highValue.thresholdCents) out.push('HIGH_VALUE');
    return out;
  }

  /** Catering context: setup needed (setting, or a catering-trays group order) and headcount. */
  private async cateringCtx(job: Job, cfg: SpecialCategoriesConfig, tx: DbOrTx = this.db) {
    const snap = special(job).catering;
    if (snap?.setupRequired !== undefined) return { setupRequired: snap.setupRequired, headcount: snap.headcount ?? null };
    let setupRequired = cfg.catering.setupRequired;
    let headcount: number | null = null;
    if (job.orderId) {
      const [g] = await tx.select({ mode: groupOrders.mode, headcount: groupOrders.headcount }).from(orders).innerJoin(groupOrders, eq(groupOrders.id, orders.groupOrderId)).where(eq(orders.id, job.orderId)).limit(1);
      if (g) { headcount = g.headcount ?? null; if (g.mode === 'CATERING_TRAYS') setupRequired = true; }
    }
    return { setupRequired, headcount: special(job).catering?.headcount ?? headcount };
  }

  /** Scheduled catering orders are offered early so a qualified courier is lined up. */
  async cateringHold(job: Job, reqs: string[], tx: DbOrTx): Promise<Date | null> {
    if (!reqs.includes('CATERING') || !job.orderId) return null;
    const [o] = await tx.select({ at: orders.scheduledFor }).from(orders).where(eq(orders.id, job.orderId)).limit(1);
    if (!o?.at) return null;
    const cfg = await this.cfg();
    const t = new Date(o.at.getTime() - cfg.catering.dispatchLeadMinutes * 60_000);
    return t.getTime() > Date.now() ? t : null;
  }

  /** At dispatch: keep what the catering handoff needs (setup, headcount), so later setting changes don't move the goalposts. */
  async snapshot(job: Job, reqs: string[], tx: DbOrTx): Promise<SpecialRecord | null> {
    if (!reqs.includes('CATERING') || special(job).catering?.setupRequired !== undefined) return null;
    const ctx = await this.cateringCtx({ ...job, requirements: reqs }, await this.cfg(), tx);
    return { ...special(job), catering: { ...(special(job).catering ?? {}), setupRequired: ctx.setupRequired, headcount: ctx.headcount } };
  }

  noBatch(reqs: string[]) { return reqs.filter((r) => (NO_BATCH_CATEGORIES as string[]).includes(r)); }

  // ───── dispatch ─────

  async dispatchCtx(reqs: string[], tx: DbOrTx): Promise<DispatchCtx | null> {
    if (!cats(reqs).length) return null;
    const cfg = await this.cfg();
    const delivered = new Map<string, number>();
    const openCases = new Set<string>();
    if (reqs.includes('HIGH_VALUE')) {
      for (const r of await tx.select({ d: deliveryJobs.driverId, n: sql<number>`count(*)::int` }).from(deliveryJobs).where(eq(deliveryJobs.status, 'DELIVERED')).groupBy(deliveryJobs.driverId)) if (r.d) delivered.set(r.d, r.n);
      for (const r of await tx.select({ d: courierFraudCases.driverId }).from(courierFraudCases).where(eq(courierFraudCases.status, 'OPEN'))) openCases.add(r.d);
    }
    return { cfg, delivered, openCases };
  }

  /** Why a courier can't take a job with these categories (null = eligible). `transitMinutes` = to pickup + trip. */
  ineligible(d: Driver, reqs: string[], ctx: DispatchCtx | null, transitMinutes: number): string | null {
    if (!ctx) return null;
    const { cfg } = ctx;
    for (const c of cats(reqs)) {
      if (c !== 'HIGH_VALUE' && !d.capabilities.includes(c)) return `${c}: not certified`;
      if (c === 'CATERING' && !cfg.catering.vehicleTypes.includes(d.vehicleType)) return 'CATERING: vehicle';
      if (c === 'TEMP_CONTROLLED' && !d.capabilities.includes('COLD_BAG')) return 'TEMP_CONTROLLED: no cold bag';
      if (c === 'TEMP_CONTROLLED' && transitMinutes > cfg.tempControl.maxTransitMinutes) return 'TEMP_CONTROLLED: too far';
      if (c === 'HIGH_VALUE') { const why = this.highValueBlock(d, ctx.delivered.get(d.id) ?? 0, ctx.openCases.has(d.id), cfg); if (why) return `HIGH_VALUE: ${why}`; }
    }
    if (cats(reqs).length && d.lifecycleStatus === 'RESTRICTED') return 'restricted account';
    return null;
  }

  private highValueBlock(d: Driver, delivered: number, openCase: boolean, cfg: SpecialCategoriesConfig): string | null {
    const h = cfg.highValue;
    if (d.lifecycleStatus !== 'ACTIVE') return 'Your account must be active';
    if (openCase) return 'An account review is open';
    if (delivered < h.minDeliveries) return `Complete ${h.minDeliveries} deliveries (you have ${delivered})`;
    if (h.minRating > 0 && (d.ratingAvg ?? 0) < h.minRating && d.ratingCount > 0) return `Keep a ${h.minRating.toFixed(1)}★ rating`;
    if (d.createdAt.getTime() > Date.now() - h.minAccountDays * 86400_000) return `Your account must be ${h.minAccountDays} days old`;
    return null;
  }

  premium(reqs: string[], cfg: SpecialCategoriesConfig): SpecialPremium[] {
    return cats(reqs).map((c) => ({ category: c, label: SPECIAL_CATEGORY_LABELS[c], cents: cfg.premiumCents[c] ?? 0 })).filter((p) => p.cents > 0);
  }

  // ───── handoff ─────

  private async recipientName(job: Job, tx: DbOrTx = this.db) {
    const drop = job.dropoffAddress as { contactName?: string };
    if (drop?.contactName) return drop.contactName;
    if (!job.orderId) return null;
    const [r] = await tx.select({ name: users.name }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(eq(orders.id, job.orderId)).limit(1);
    return r?.name ?? null;
  }

  async handoffFor(job: Job, cfg?: SpecialCategoriesConfig): Promise<HandoffRequirements> {
    const c = cfg ?? await this.cfg();
    const k = cats(job.requirements);
    const has = (x: SpecialCategory) => k.includes(x);
    return {
      categories: k,
      ageCheck: has('ALCOHOL') ? { minAge: c.alcohol.minAge, idTypes: c.alcohol.idTypes, requireDob: c.alcohol.requireDob } : null,
      signature: has('SENSITIVE') || has('CATERING'),
      recipientName: has('SENSITIVE') ? await this.recipientName(job) : null,
      pin: has('HIGH_VALUE'),
      sealCheck: has('SENSITIVE'),
      noSafePlace: has('SENSITIVE') || has('HIGH_VALUE') || has('ALCOHOL'),
      tempControl: has('TEMP_CONTROLLED') ? c.tempControl : null,
      catering: has('CATERING') ? await this.cateringCtx(job, c) : null,
    };
  }

  async customerRequirements(job: Job): Promise<CustomerHandoffRequirements | null> {
    if (!cats(job.requirements).length) return null;
    const h = await this.handoffFor(job);
    return { ageCheck: h.ageCheck ? { minAge: h.ageCheck.minAge } : null, signature: h.signature, recipientName: h.recipientName, pin: h.pin, noSafePlace: h.noSafePlace, temperatureControlled: !!h.tempControl };
  }

  /** Local HH:MM and YYYY-MM-DD at the pickup location. */
  private async localNow(job: Job) {
    const [loc] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    const tz = loc?.tz || 'America/New_York';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  /**
   * Category rules for DELIVERED. Runs before the generic proof checks; returns the special record to store.
   * The date of birth is used to compute the age and is never stored.
   */
  async checkHandoff(job: Job, data: { ageCheck?: { dob: string; idType: string; idLast4?: string }; idChecked?: boolean; recipientName?: string; sealIntact?: boolean; proofSignature?: string; handoffPin?: string }): Promise<SpecialRecord | null> {
    const k = cats(job.requirements);
    if (!k.length) return null;
    const cfg = await this.cfg();
    const rec: SpecialRecord = { ...special(job) };
    const now = new Date();
    if (k.includes('ALCOHOL')) {
      const local = await this.localNow(job);
      const { start, end } = cfg.alcohol.deliveryHours;
      const inHours = start === end || (start < end ? local.time >= start && local.time < end : local.time >= start || local.time < end);
      if (!inHours) throw new ConflictException({ message: `Alcohol can only be handed over between ${start} and ${end}. Tap “Can’t hand over” and return it.`, code: 'ALCOHOL_HOURS' });
      if (data.ageCheck) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.ageCheck.dob)) throw new BadRequestException({ message: 'Enter the date of birth from the ID', code: 'ID_CHECK_REQUIRED' });
        if (!cfg.alcohol.idTypes.includes(data.ageCheck.idType)) throw new BadRequestException({ message: 'That type of ID isn’t accepted', code: 'ID_TYPE_INVALID' });
        const age = ageOn(data.ageCheck.dob, local.date);
        if (age < cfg.alcohol.minAge) throw new BadRequestException({ message: `The customer is under ${cfg.alcohol.minAge}. Don’t hand over the order — tap “Can’t hand over” (under age).`, code: 'UNDERAGE', age });
        if (age > 120) throw new BadRequestException({ message: 'Check the date of birth', code: 'ID_CHECK_REQUIRED' });
        rec.ageCheck = { age, idType: data.ageCheck.idType, idLast4: data.ageCheck.idLast4?.slice(-4) ?? null, checkedAt: now.toISOString() };
      } else if (data.idChecked && !cfg.alcohol.requireDob) {
        rec.ageCheck = { age: cfg.alcohol.minAge, idType: 'UNRECORDED', checkedAt: now.toISOString(), legacy: true };
      } else {
        throw new BadRequestException({ message: 'Check the customer’s ID: enter their date of birth and the ID type', code: 'ID_CHECK_REQUIRED' });
      }
    }
    if (k.includes('SENSITIVE')) {
      if (!data.proofSignature) throw new BadRequestException({ message: 'A sensitive order needs the recipient’s signature', code: 'SIGNATURE_REQUIRED' });
      if (data.sealIntact !== true) throw new BadRequestException({ message: 'Confirm the seal is intact. If it’s broken, tap “Can’t hand over”.', code: 'SEAL_CHECK_REQUIRED' });
      const expected = await this.recipientName(job);
      if (cfg.sensitive.requireNameMatch && expected && !recipientMatches(expected, data.recipientName)) throw new BadRequestException({ message: 'Only the person named on the order can receive it', code: 'RECIPIENT_MISMATCH' });
      rec.recipientName = data.recipientName?.trim() ?? undefined;
      rec.sealIntact = true;
    }
    if (k.includes('HIGH_VALUE') && !data.handoffPin) throw new BadRequestException({ message: 'Ask the customer for their delivery PIN', code: 'PIN_REQUIRED' });
    if (k.includes('CATERING')) {
      if (!data.proofSignature) throw new BadRequestException({ message: 'Get a signature for the catering order', code: 'SIGNATURE_REQUIRED' });
      const ctx = await this.cateringCtx(job, cfg);
      const cl = rec.catering?.checklist ?? {};
      if (!cl.itemsCounted) throw new BadRequestException({ message: 'Count the items with the customer first', code: 'CATERING_CHECKLIST' });
      if (ctx.setupRequired && !cl.setupDone) throw new BadRequestException({ message: 'Finish the setup first', code: 'CATERING_SETUP' });
      rec.catering = { ...rec.catering, setupRequired: ctx.setupRequired };
    }
    if (k.includes('TEMP_CONTROLLED') && cfg.tempControl.requireReadings && !(rec.temps ?? []).some((t) => t.stage === 'DROPOFF')) throw new BadRequestException({ message: 'Log the temperature at the drop-off', code: 'TEMP_READING_REQUIRED' });
    return rec;
  }

  /** After DELIVERED: transit / temperature breach (support case). Never blocks the handoff. */
  async onDelivered(job: Job, reporterId: string, tx: DbOrTx) {
    if (!job.requirements.includes('TEMP_CONTROLLED')) return null;
    const cfg = await this.cfg();
    const rec = special(job);
    if (rec.breach) return rec.breach;
    const transit = job.pickedUpAt && job.deliveredAt ? minutes(job.pickedUpAt, job.deliveredAt) : 0;
    if (transit > cfg.tempControl.maxTransitMinutes) return this.breach(job, 'TRANSIT', `${Math.round(transit)} min in transit (limit ${cfg.tempControl.maxTransitMinutes})`, reporterId, tx);
    return null;
  }

  private async breach(job: Job, kind: 'TRANSIT' | 'TEMPERATURE', detail: string, reporterId: string, tx: DbOrTx) {
    const [cur] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id)).limit(1);
    const rec = special(cur);
    if (rec.breach) return rec.breach;
    const inc = await this.incident(tx, cur, reporterId, 'TEMPERATURE_BREACH', `Temperature-controlled order: ${detail}`, 'NORMAL');
    const b = { kind, detail, at: new Date().toISOString(), incidentId: inc.id };
    await tx.update(deliveryJobs).set({ special: { ...rec, breach: b } }).where(eq(deliveryJobs.id, job.id));
    await this.event(job.id, 'TEMPERATURE_BREACH', { kind, detail }, tx);
    return b;
  }

  /** Premium (+ catering setup) paid once per delivered job as a SPECIAL earning. */
  async payPremium(job: Job, tx: DbOrTx) {
    if (!job.driverId || job.fleet !== 'PLATFORM' || !cats(job.requirements).length) return null;
    const cfg = await this.cfg();
    const snap = (job.payPolicy as { special?: SpecialPremium[] } | null)?.special;
    const prem = snap ?? this.premium(job.requirements, cfg);
    const rec = special(job);
    const setupMinutes = job.requirements.includes('CATERING') ? Math.min(cfg.catering.maxSetupMinutes, Math.floor(rec.catering?.setupMinutes ?? 0)) : 0;
    const setupCents = setupMinutes * cfg.catering.setupPerMinuteCents;
    const total = prem.reduce((t, p) => t + p.cents, 0) + setupCents;
    if (total <= 0) return null;
    const policy = await this.delivery.payPolicy();
    const [e] = await tx.insert(driverEarnings).values({ driverId: job.driverId, deliveryJobId: job.id, kind: 'SPECIAL', baseCents: total, reason: prem.map((p) => p.label).join(', ') || 'Catering setup', detail: { premium: prem, setupMinutes, setupCents }, policyVersion: policy.version, availableAt: new Date(Date.now() + policy.holdHours * 3600_000) }).onConflictDoNothing().returning();
    if (!e) return null;
    const [loc] = await tx.select({ currency: locations.currency }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    await this.ledger.post({ orderId: job.orderId, currency: loc?.currency || 'USD' }, [
      { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: total, memo: `Courier special-category pay job ${job.id}` },
      { account: 'DRIVER_PAYABLE', partyId: job.driverId, creditCents: total, memo: 'Special-category pay' },
    ], tx);
    await tx.update(deliveryJobs).set({ special: { ...rec, premium: prem.map((p) => ({ category: p.category, cents: p.cents })) } }).where(eq(deliveryJobs.id, job.id));
    return e;
  }

  // ───── courier actions on a trip ─────

  private async myJob(user: JwtPayload, jobId: string) {
    const d = await this.delivery.myDriver(user);
    const [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.driverId, d.id))).limit(1);
    if (!job) throw new NotFoundException();
    return { d, job };
  }

  async refuseHandoff(user: JwtPayload, jobId: string, b: { reason: RefusalReason; note?: string }) {
    const { d, job } = await this.myJob(user, jobId);
    if (job.status !== 'PICKED_UP') throw new ConflictException('Only an order you are carrying can be refused at the door');
    if (!cats(job.requirements).length) throw new BadRequestException({ message: 'This order has no handoff restrictions; report a problem instead', code: 'NOT_RESTRICTED' });
    const policy = await this.delivery.payPolicy();
    return this.db.transaction(async (tx) => {
      const u = await this.refuseTx(tx, job, d.id, user.sub, b.reason, b.note);
      return { job: { ...u, handoffPin: undefined }, outcome: `Don’t hand over the order. Take it back to the kitchen and ask them to confirm they received it; you’ll get ${(policy.returnCents / 100).toFixed(2)} return pay.` };
    });
  }

  /** RETURNED with custody kept by the courier until the kitchen confirms receipt; incident + customer notice. */
  async refuseTx(tx: DbOrTx, job: Job, driverId: string, reporterId: string, reason: RefusalReason, note?: string | null) {
    const label = REFUSAL_LABELS[reason] ?? reason;
    await this.delivery.transition(job.id, 'RETURNED', { reason: `Handoff refused: ${label}`, costOwner: 'CUSTOMER' }, tx);
    const inc = await this.incident(tx, job, reporterId, 'RESTRICTED_RETURN', `Handoff refused (${label})${note ? ` — ${note}` : ''}. The courier is returning the order; the kitchen must confirm receipt.`, 'HIGH');
    const [cur] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id)).limit(1);
    const [u] = await tx.update(deliveryJobs).set({ custody: 'COURIER', cancelReason: `Handoff refused: ${label}`, costOwner: 'CUSTOMER', special: { ...special(cur), refusal: { reason, note: note ?? null, at: new Date().toISOString(), incidentId: inc.id } } }).where(eq(deliveryJobs.id, job.id)).returning();
    await this.event(job.id, 'HANDOFF_REFUSED', { reason, driverId, incidentId: inc.id }, tx);
    await this.outbox.publish('delivery.failed', job.id, { orderId: job.orderId, status: 'RETURNED', reason: `handoff refused: ${label.toLowerCase()}` }, tx);
    return u;
  }

  async temperature(user: JwtPayload, jobId: string, b: { stage: 'PICKUP' | 'DROPOFF'; tempC: number }) {
    const { job } = await this.myJob(user, jobId);
    if (!['ASSIGNED', 'PICKED_UP'].includes(job.status)) throw new ConflictException(`Delivery is ${job.status}`);
    const cfg = await this.cfg();
    return this.db.transaction(async (tx) => {
      const rec = special(job);
      const temps = [...(rec.temps ?? []), { stage: b.stage, tempC: Math.round(b.tempC * 10) / 10, at: new Date().toISOString() }];
      await tx.update(deliveryJobs).set({ special: { ...rec, temps } }).where(eq(deliveryJobs.id, job.id));
      let breach = rec.breach ?? null;
      if (job.requirements.includes('TEMP_CONTROLLED') && b.tempC > cfg.tempControl.coldMaxC) breach = await this.breach(job, 'TEMPERATURE', `${b.stage.toLowerCase()} reading ${b.tempC} °C (limit ${cfg.tempControl.coldMaxC} °C)`, user.sub, tx);
      return { temps, breach, note: breach ? 'Logged. Support will follow up with the customer — complete the handoff unless they refuse it.' : null };
    });
  }

  async catering(user: JwtPayload, jobId: string, b: { startSetup?: boolean; finishSetup?: boolean; checklist?: { itemsCounted?: boolean; utensils?: boolean; labelsShown?: boolean }; headcount?: number }) {
    const { job } = await this.myJob(user, jobId);
    if (!job.requirements.includes('CATERING')) throw new BadRequestException({ message: 'This isn’t a catering order', code: 'NOT_CATERING' });
    if (job.status !== 'PICKED_UP') throw new ConflictException('Pick the order up first');
    const cfg = await this.cfg();
    const rec = special(job);
    const c = { ...(rec.catering ?? {}), checklist: { ...(rec.catering?.checklist ?? {}), ...(b.checklist ?? {}) } };
    const now = new Date();
    if (b.startSetup && !c.setupStartedAt) c.setupStartedAt = now.toISOString();
    if (b.finishSetup) {
      if (!c.setupStartedAt) throw new ConflictException({ message: 'Start the setup timer first', code: 'CATERING_SETUP' });
      c.setupDoneAt = now.toISOString();
      c.checklist.setupDone = true;
      c.setupMinutes = Math.min(cfg.catering.maxSetupMinutes, Math.round(minutes(new Date(c.setupStartedAt), now) * 10) / 10);
    }
    if (b.headcount !== undefined) c.headcount = b.headcount;
    await this.db.update(deliveryJobs).set({ special: { ...rec, catering: c } }).where(eq(deliveryJobs.id, job.id));
    return { catering: c, setupPayCents: Math.floor(c.setupMinutes ?? 0) * cfg.catering.setupPerMinuteCents };
  }

  /** Kitchen (or delivery staff) confirms a refused order came back. */
  async returnReceived(user: JwtPayload, jobId: string, b: { sealIntact: boolean; note?: string }) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (!isPlatformStaff(user)) {
      const [loc] = await this.db.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
      assertOrgAccess(user, loc!.org, job.locationId);
    } else assertCan(user, 'delivery.manage');
    if (job.status !== 'RETURNED' || job.custody !== 'COURIER') throw new ConflictException({ message: 'Nothing is waiting to be received for this delivery', code: 'NOT_RETURNING' });
    const rec = special(job);
    const [u] = await this.db.update(deliveryJobs).set({ custody: 'RETURNED', special: { ...rec, returnReceived: { at: new Date().toISOString(), byId: user.sub, sealIntact: b.sealIntact, note: b.note ?? null } } }).where(eq(deliveryJobs.id, jobId)).returning();
    await this.event(jobId, 'RETURN_RECEIVED', { by: user.sub, sealIntact: b.sealIntact, note: b.note });
    if (!b.sealIntact) await this.incident(this.db, job, user.sub, 'RESTRICTED_RETURN', `Returned order received with a broken seal${b.note ? ` — ${b.note}` : ''}`, 'HIGH', 'MERCHANT', isPlatformStaff(user) ? 'STAFF' : 'MERCHANT');
    return { ...u, handoffPin: undefined };
  }

  /** Refused orders on their way back to a location (kitchen list). */
  async returns(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (!isPlatformStaff(user)) assertOrgAccess(user, loc.org, locationId);
    const rows = await this.db.select({ j: deliveryJobs, number: orders.number, courier: users.name }).from(deliveryJobs).leftJoin(orders, eq(orders.id, deliveryJobs.orderId)).leftJoin(drivers, eq(drivers.id, deliveryJobs.driverId)).leftJoin(users, eq(users.id, drivers.userId)).where(and(eq(deliveryJobs.locationId, locationId), eq(deliveryJobs.status, 'RETURNED'), eq(deliveryJobs.custody, 'COURIER'))).orderBy(desc(deliveryJobs.updatedAt)).limit(50);
    return rows.map(({ j, number, courier }) => ({ jobId: j.id, orderId: j.orderId, orderNumber: number, courierFirstName: courier?.split(' ')[0] ?? null, categories: cats(j.requirements), refusal: special(j).refusal ?? null, since: special(j).refusal?.at ?? j.updatedAt }));
  }

  // ───── certifications ─────

  private async setCapability(tx: DbOrTx, driverId: string, cap: string, on: boolean) {
    const [d] = await tx.select({ caps: drivers.capabilities }).from(drivers).where(eq(drivers.id, driverId)).limit(1);
    if (!d) return;
    const s = new Set(d.caps);
    if (on) s.add(cap); else s.delete(cap);
    await tx.update(drivers).set({ capabilities: [...s] }).where(eq(drivers.id, driverId));
  }

  private async screeningPassed(driverId: string) {
    const [r] = await this.db.select({ s: courierEligibility.status }).from(courierEligibility).where(and(eq(courierEligibility.driverId, driverId), eq(courierEligibility.check, 'SCREENING'))).limit(1);
    return r?.s === 'PASSED';
  }

  private async certRows(driverId: string) {
    return this.db.select().from(courierCertifications).where(eq(courierCertifications.driverId, driverId));
  }

  async highValueStatus(d: Driver) {
    const cfg = await this.cfg();
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), eq(deliveryJobs.status, 'DELIVERED')));
    const [c] = await this.db.select({ id: courierFraudCases.id }).from(courierFraudCases).where(and(eq(courierFraudCases.driverId, d.id), eq(courierFraudCases.status, 'OPEN'))).limit(1);
    const reason = this.highValueBlock(d, n, !!c, cfg);
    return { eligible: !reason, reason, deliveries: n, minDeliveries: cfg.highValue.minDeliveries, thresholdCents: cfg.highValue.thresholdCents };
  }

  private async view(d: Driver) {
    const rows = await this.certRows(d.id);
    const cfg = await this.cfg();
    const screening = await this.screeningPassed(d.id);
    const certifications = CERTIFIABLE_CATEGORIES.map((category) => {
      const r = rows.find((x) => x.category === category);
      const t = CATEGORY_TRAINING[category];
      const needs: string[] = [];
      if (!r?.trainingPassedAt || ['EXPIRED', 'REJECTED'].includes(r.status)) needs.push('TRAINING');
      if (t.needs.includes('CERTIFICATE') && (!r?.certificateFileUrl || r.status === 'REJECTED' || r.status === 'EXPIRED')) needs.push('CERTIFICATE');
      if (t.needs.includes('SCREENING') && !screening) needs.push('SCREENING');
      if (category === 'CATERING' && !cfg.catering.vehicleTypes.includes(d.vehicleType)) needs.push('VEHICLE');
      if (category === 'TEMP_CONTROLLED' && !d.capabilities.includes('COLD_BAG')) needs.push('COLD_BAG');
      return {
        id: r?.id ?? null, category, label: SPECIAL_CATEGORY_LABELS[category], status: r?.status ?? 'NONE', expiresAt: r?.expiresAt ?? null, note: r?.note ?? null,
        trainingPassedAt: r?.trainingPassedAt ?? null, certificateUploaded: !!r?.certificateFileUrl, submittedAt: r?.submittedAt ?? null,
        premiumCents: cfg.premiumCents[category], needs,
        training: { title: t.title, body: t.body, questions: t.questions.map((q) => ({ q: q.q, options: q.options })) },
      };
    });
    return { certifications, highValue: await this.highValueStatus(d) };
  }

  async myCertifications(user: JwtPayload) {
    return this.view(await this.delivery.myDriver(user));
  }

  async passTraining(user: JwtPayload, category: CertifiableCategory, answers: number[]) {
    const d = await this.delivery.myDriver(user);
    const t = CATEGORY_TRAINING[category];
    if (!t) throw new BadRequestException('Unknown category');
    const wrong = t.questions.map((q, i) => (answers[i] === q.answer ? -1 : i)).filter((i) => i >= 0);
    if (wrong.length) throw new ConflictException({ message: 'Some answers aren’t right yet. Read the guide again and retry.', code: 'TRAINING_FAILED', wrong });
    const [cur] = await this.db.select().from(courierCertifications).where(and(eq(courierCertifications.driverId, d.id), eq(courierCertifications.category, category))).limit(1);
    if (cur?.status === 'REVOKED') throw new ConflictException({ message: 'This certification was revoked. Contact courier support.', code: 'CERT_REVOKED' });
    if (cur?.status === 'ACTIVE' && cur.expiresAt && cur.expiresAt > new Date()) return this.view(d);
    const cfg = await this.cfg();
    const now = new Date();
    const certificateOk = !t.needs.includes('CERTIFICATE') || (!!cur?.certificateFileUrl && cur.status !== 'REJECTED' && cur.status !== 'EXPIRED');
    const review = t.needs.length > 0;
    const status = !certificateOk ? 'TRAINING' : review ? 'PENDING' : 'ACTIVE';
    const vals = { trainingPassedAt: now, status, submittedAt: status === 'PENDING' ? now : null, expiresAt: status === 'ACTIVE' ? new Date(now.getTime() + cfg.certValidDays * 86400_000) : null, note: null, ...(certificateOk ? {} : { certificateFileUrl: null }) };
    await this.db.transaction(async (tx) => {
      await tx.insert(courierCertifications).values({ driverId: d.id, category, ...vals }).onConflictDoUpdate({ target: [courierCertifications.driverId, courierCertifications.category], set: { ...vals, updatedAt: now } });
      if (status === 'ACTIVE') await this.setCapability(tx, d.id, category, true);
    });
    const [fresh] = await this.db.select().from(drivers).where(eq(drivers.id, d.id)).limit(1);
    return this.view(fresh);
  }

  async uploadCertificate(user: JwtPayload, category: CertifiableCategory, b: { fileUrl: string; expiresAt?: string }) {
    const d = await this.delivery.myDriver(user);
    if (!CATEGORY_TRAINING[category]?.needs.includes('CERTIFICATE')) throw new BadRequestException({ message: 'This category doesn’t need a certificate', code: 'NO_CERTIFICATE' });
    const fid = storedFileId(b.fileUrl);
    if (!fid) throw new BadRequestException({ message: 'Upload the certificate in the app', code: 'PHOTO_INVALID' });
    const [f] = await this.db.select({ driverId: storedFiles.driverId }).from(storedFiles).where(eq(storedFiles.id, fid)).limit(1);
    if (!f || f.driverId !== d.id) throw new BadRequestException({ message: 'Upload the certificate again', code: 'PHOTO_INVALID' });
    const exp = b.expiresAt ? new Date(b.expiresAt) : null;
    if (exp && exp <= new Date()) throw new BadRequestException({ message: 'That certificate has expired', code: 'CERTIFICATE_EXPIRED' });
    const [cur] = await this.db.select().from(courierCertifications).where(and(eq(courierCertifications.driverId, d.id), eq(courierCertifications.category, category))).limit(1);
    if (cur?.status === 'REVOKED') throw new ConflictException({ message: 'This certification was revoked. Contact courier support.', code: 'CERT_REVOKED' });
    if (cur?.status === 'ACTIVE' && cur.expiresAt && cur.expiresAt > new Date()) throw new ConflictException({ message: 'You’re already certified', code: 'ALREADY_ACTIVE' });
    const now = new Date();
    const trained = !!cur?.trainingPassedAt && cur.status !== 'EXPIRED' && cur.status !== 'REJECTED';
    const vals = { certificateFileUrl: b.fileUrl, certificateExpiresAt: exp, status: trained ? 'PENDING' : 'TRAINING', submittedAt: trained ? now : null, note: null, ...(trained ? {} : { trainingPassedAt: null }) };
    await this.db.insert(courierCertifications).values({ driverId: d.id, category, ...vals }).onConflictDoUpdate({ target: [courierCertifications.driverId, courierCertifications.category], set: { ...vals, updatedAt: now } });
    return this.view(d);
  }

  async queue(user: JwtPayload, q: { status?: string; category?: string }) {
    assertCan(user, 'delivery.read');
    const conds = [inArray(courierCertifications.status, q.status ? [q.status] : ['PENDING'])];
    if (q.category) conds.push(eq(courierCertifications.category, q.category));
    const rows = await this.db.select({ c: courierCertifications, name: users.name, email: users.email }).from(courierCertifications).innerJoin(drivers, eq(drivers.id, courierCertifications.driverId)).innerJoin(users, eq(users.id, drivers.userId)).where(and(...conds)).orderBy(courierCertifications.submittedAt).limit(200);
    const screened = new Set((await this.db.select({ d: courierEligibility.driverId }).from(courierEligibility).where(and(eq(courierEligibility.check, 'SCREENING'), eq(courierEligibility.status, 'PASSED')))).map((r) => r.d));
    return rows.map(({ c, name, email }) => ({ id: c.id, driverId: c.driverId, driverName: name, email, category: c.category, label: SPECIAL_CATEGORY_LABELS[c.category as SpecialCategory] ?? c.category, status: c.status, certificateUrl: viewableUrl(c.certificateFileUrl), certificateExpiresAt: c.certificateExpiresAt, trainingPassedAt: c.trainingPassedAt, submittedAt: c.submittedAt, expiresAt: c.expiresAt, note: c.note, screeningPassed: screened.has(c.driverId) }));
  }

  async courierCertifications(user: JwtPayload, driverId: string) {
    assertCan(user, 'delivery.read');
    const [d] = await this.db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
    if (!d) throw new NotFoundException();
    const v = await this.view(d);
    const rows = await this.certRows(d.id);
    return { ...v, certifications: v.certifications.map((c) => ({ ...c, certificateUrl: viewableUrl(rows.find((r) => r.category === c.category)?.certificateFileUrl) })) };
  }

  async decide(user: JwtPayload, id: string, b: { decision: 'APPROVE' | 'REJECT' | 'REVOKE'; reason: string; expiresAt?: string }) {
    assertCan(user, 'delivery.manage');
    const [c] = await this.db.select().from(courierCertifications).where(eq(courierCertifications.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    const cfg = await this.cfg();
    const now = new Date();
    if (b.decision === 'APPROVE' && c.status !== 'PENDING') throw new ConflictException({ message: `This certification is ${c.status}`, code: 'NOT_PENDING' });
    if (b.decision === 'REJECT' && c.status !== 'PENDING') throw new ConflictException({ message: `This certification is ${c.status}`, code: 'NOT_PENDING' });
    if (b.decision === 'REVOKE' && c.status !== 'ACTIVE') throw new ConflictException({ message: `This certification is ${c.status}`, code: 'NOT_ACTIVE' });
    if (b.decision === 'APPROVE' && CATEGORY_TRAINING[c.category as CertifiableCategory]?.needs.includes('SCREENING') && !(await this.screeningPassed(c.driverId))) throw new ConflictException({ message: 'Background screening must pass first', code: 'SCREENING_REQUIRED' });
    const limit = new Date(now.getTime() + cfg.certValidDays * 86400_000);
    const expiresAt = b.expiresAt ? new Date(b.expiresAt) : c.certificateExpiresAt && c.certificateExpiresAt < limit ? c.certificateExpiresAt : limit;
    const status = b.decision === 'APPROVE' ? 'ACTIVE' : b.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
    await this.db.transaction(async (tx) => {
      await tx.update(courierCertifications).set({ status, decidedById: user.sub, decidedAt: now, note: b.reason, expiresAt: status === 'ACTIVE' ? expiresAt : c.expiresAt, updatedAt: now }).where(eq(courierCertifications.id, id));
      await this.setCapability(tx, c.driverId, c.category, status === 'ACTIVE');
    });
    await this.audit.log({ actorId: user.sub, action: `courier.certification.${b.decision.toLowerCase()}`, entityType: 'driver', entityId: c.driverId, before: { category: c.category, status: c.status }, after: { status, expiresAt: status === 'ACTIVE' ? expiresAt : null }, reason: b.reason });
    return this.courierCertifications(user, c.driverId);
  }

  async grant(user: JwtPayload, driverId: string, b: { category: CertifiableCategory; reason: string; expiresAt?: string }) {
    assertCan(user, 'delivery.manage');
    const [d] = await this.db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
    if (!d) throw new NotFoundException();
    const cfg = await this.cfg();
    const now = new Date();
    const expiresAt = b.expiresAt ? new Date(b.expiresAt) : new Date(now.getTime() + cfg.certValidDays * 86400_000);
    if (expiresAt <= now) throw new BadRequestException('The expiry must be in the future');
    const vals = { status: 'ACTIVE', decidedById: user.sub, decidedAt: now, note: b.reason, expiresAt, trainingPassedAt: now };
    await this.db.transaction(async (tx) => {
      await tx.insert(courierCertifications).values({ driverId, category: b.category, ...vals }).onConflictDoUpdate({ target: [courierCertifications.driverId, courierCertifications.category], set: { ...vals, updatedAt: now } });
      await this.setCapability(tx, driverId, b.category, true);
    });
    await this.audit.log({ actorId: user.sub, action: 'courier.certification.grant', entityType: 'driver', entityId: driverId, after: { category: b.category, expiresAt }, reason: b.reason });
    return this.courierCertifications(user, driverId);
  }

  /** Hourly: expire certifications (drop the capability) and alert on refused orders the kitchen hasn't received. */
  async sweep() {
    const now = new Date();
    const due = await this.db.select().from(courierCertifications).where(and(eq(courierCertifications.status, 'ACTIVE'), lte(courierCertifications.expiresAt, now)));
    for (const c of due) {
      await this.db.transaction(async (tx) => {
        await tx.update(courierCertifications).set({ status: 'EXPIRED', updatedAt: now }).where(eq(courierCertifications.id, c.id));
        await this.setCapability(tx, c.driverId, c.category, false);
      });
    }
    const cfg = await this.cfg();
    const late = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.status, 'RETURNED'), eq(deliveryJobs.custody, 'COURIER'), lt(deliveryJobs.updatedAt, new Date(now.getTime() - cfg.returnReceiveHours * 3600_000)), gte(deliveryJobs.updatedAt, new Date(now.getTime() - 14 * 86400_000))));
    let alerts = 0;
    for (const j of late) {
      const [loc] = await this.db.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, j.locationId)).limit(1);
      const r = await this.db.insert(opsAlerts).values({ type: 'MANUAL', severity: 'HIGH', title: 'Refused order not returned to the kitchen', detail: `A refused ${cats(j.requirements).map((c) => SPECIAL_CATEGORY_LABELS[c].toLowerCase()).join(', ')} order hasn’t been confirmed back at the kitchen after ${cfg.returnReceiveHours} h. Contact the courier and the kitchen.`, subjectType: 'delivery_job', subjectId: j.id, organizationId: loc?.org ?? null, locationId: j.locationId, dedupeKey: `special-return:${j.id}`, ownerRole: 'DISPATCHER', escalateAt: new Date(now.getTime() + 30 * 60_000), history: [{ at: now.toISOString(), by: null, action: 'RAISED', note: 'Return not received' }] }).onConflictDoNothing().returning({ id: opsAlerts.id });
      alerts += r.length;
    }
    return { expired: due.length, overdueReturns: late.length, alerts };
  }

  async sweepAsStaff(user: JwtPayload) {
    assertCan(user, 'delivery.manage');
    return this.sweep();
  }

  // ───── admin views ─────

  async jobSpecial(user: JwtPayload, jobId: string) {
    assertCan(user, 'delivery.read');
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    return { jobId, categories: cats(job.requirements), custody: job.custody, status: job.status, special: special(job), handoff: await this.handoffFor(job) };
  }

  async report(user: JwtPayload, q: { from?: string; to?: string }) {
    assertCan(user, 'delivery.read');
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
    const jobs = await this.db.select().from(deliveryJobs).where(and(gte(deliveryJobs.createdAt, from), lte(deliveryJobs.createdAt, to), sql`${deliveryJobs.requirements} && ${sql.raw(`ARRAY[${SPECIAL_CATEGORIES.map((c) => `'${c}'`).join(',')}]::text[]`)}`));
    const premiums = jobs.length ? await this.db.select({ j: driverEarnings.deliveryJobId, c: driverEarnings.baseCents }).from(driverEarnings).where(and(eq(driverEarnings.kind, 'SPECIAL'), inArray(driverEarnings.deliveryJobId, jobs.map((j) => j.id)))) : [];
    const paid = new Map(premiums.map((p) => [p.j, p.c]));
    const categories = SPECIAL_CATEGORIES.map((category) => {
      const js = jobs.filter((j) => j.requirements.includes(category));
      const refused: Record<string, number> = {};
      for (const j of js) { const r = special(j).refusal; if (r) refused[r.reason] = (refused[r.reason] ?? 0) + 1; }
      return {
        category, label: SPECIAL_CATEGORY_LABELS[category], jobs: js.length, delivered: js.filter((j) => j.status === 'DELIVERED').length,
        refused, refusedTotal: Object.values(refused).reduce((a, b) => a + b, 0),
        idChecks: js.filter((j) => special(j).ageCheck).length, legacyIdChecks: js.filter((j) => special(j).ageCheck?.legacy).length,
        breaches: js.filter((j) => special(j).breach).length, awaitingReturn: js.filter((j) => j.status === 'RETURNED' && j.custody === 'COURIER').length,
        premiumCents: js.reduce((t, j) => t + (paid.get(j.id) ?? 0), 0),
      };
    });
    const pending = await this.db.select({ n: sql<number>`count(*)::int` }).from(courierCertifications).where(eq(courierCertifications.status, 'PENDING'));
    const active = await this.db.select({ c: courierCertifications.category, n: sql<number>`count(*)::int` }).from(courierCertifications).where(eq(courierCertifications.status, 'ACTIVE')).groupBy(courierCertifications.category);
    return { from, to, categories, certifications: { pending: pending[0]?.n ?? 0, active: Object.fromEntries(active.map((a) => [a.c, a.n])) } };
  }

  // ───── helpers ─────

  private async incident(tx: DbOrTx, job: Job, reporterId: string, category: string, description: string, priority: string, owner = 'PLATFORM', reporterType = 'DRIVER') {
    const [loc] = await tx.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    const [inc] = await tx.insert(incidents).values({ orderId: job.orderId, deliveryJobId: job.id, organizationId: loc?.org ?? null, reporterType, reporterId, category, description, priority, queue: 'DELIVERY', owner }).returning();
    return inc;
  }

  private async event(jobId: string, type: string, data: Record<string, unknown>, tx: DbOrTx = this.db) {
    await tx.insert(deliveryEvents).values({ deliveryJobId: jobId, type, data });
  }

  assertSafePlaceAllowed(job: Job) {
    const blocked = cats(job.requirements).filter((c) => ['SENSITIVE', 'HIGH_VALUE', 'ALCOHOL'].includes(c));
    if (blocked.length) throw new ForbiddenException({ message: `A ${blocked.map((c) => SPECIAL_CATEGORY_LABELS[c].toLowerCase()).join(' / ')} order can’t be left unattended. Return it instead.`, code: 'SAFE_PLACE_NOT_ALLOWED' });
  }
}
