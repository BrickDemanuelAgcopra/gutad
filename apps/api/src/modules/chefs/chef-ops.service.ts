import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { CHEF_QUALITY_EVENT_LABELS, DEFAULT_CHEF_QUALITY_POLICY, requirementsFor, type ChefDocState, type ChefQualityAction, type ChefQualityPolicy } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { chefDishes, chefDocRequirements, chefDocuments, chefProfiles, chefQualityEvents, incidents, journalEntries, locations, menuItems, opsAlerts, orderLines, orders } from '../../db/schema';
import { assertCan, can, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { ChefDishesService } from './chef-dishes.service';
import { ChefsService } from './chefs.service';

type Profile = typeof chefProfiles.$inferSelect;
type Doc = typeof chefDocuments.$inferSelect;
const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const DAY = 86_400_000;
/** the reason the order flow stores when a chef doesn't confirm in time */
const UNCONFIRMED = 'The chef didn’t confirm in time';

export interface DocStatus { key: string; label: string; needsExpiry: boolean; state: ChefDocState; expiresAt: string | null; docId: string | null; pendingDocId: string | null; pendingFileId: string | null; note: string | null }
export interface ChefMetrics { chefId: string; displayName: string; slug: string; organizationId: string; status: string; statusCause: string | null; acceptingOrders: boolean; orders: number; completed: number; declined: number; unconfirmed: number; canceled: number; gmvCents: number; avgAcceptMinutes: number | null; incidents: number; foodSafety: number; incidentRatePct: number | null; declineRatePct: number | null; rating: number | null; ratings: number; requests: number; avgRequestResponseMinutes: number | null; flags: string[] }

/**
 * Chef Network operations (Phase 7): kitchen documents and their expiry, quality monitoring with automatic and staff
 * actions, chef earnings, and the network analytics dashboard.
 */
@Injectable()
export class ChefOpsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly dishes: ChefDishesService,
    private readonly chefs: ChefsService,
  ) {}

  policy() {
    return this.settings.getObject<ChefQualityPolicy>('chefs.quality', DEFAULT_CHEF_QUALITY_POLICY);
  }

  // ───── documents ─────

  /** Required documents of each chef with their current state (latest approved copy, renewal in review, …). */
  private async docStatuses(profiles: Profile[], now = new Date()): Promise<Map<string, DocStatus[]>> {
    const reqs = (await this.db.select().from(chefDocRequirements).where(eq(chefDocRequirements.active, true))).map((r) => ({ key: r.key, label: r.label, description: r.description, regions: r.regions, kitchenTypes: r.kitchenTypes, required: r.required, needsExpiry: r.needsExpiry }));
    const appIds = profiles.map((p) => p.applicationId).filter((x): x is string => !!x);
    const docs = appIds.length ? await this.db.select().from(chefDocuments).where(inArray(chefDocuments.applicationId, appIds)).orderBy(desc(chefDocuments.createdAt)) : [];
    const out = new Map<string, DocStatus[]>();
    for (const p of profiles) {
      const mine = docs.filter((d) => d.applicationId === p.applicationId);
      const list = requirementsFor(reqs, p.serviceRegion ?? undefined, p.kitchenType ?? undefined).filter((r) => r.required);
      out.set(p.id, list.map((r) => this.docState(r, mine.filter((d) => d.requirementKey === r.key), now)));
    }
    return out;
  }

  private docState(r: { key: string; label: string; needsExpiry: boolean }, docs: Doc[], now: Date): DocStatus {
    const approved = docs.find((d) => d.status === 'APPROVED');
    const latest = docs[0];
    const pending = docs.find((d) => d.status === 'SUBMITTED' && (!approved || d.createdAt > approved.createdAt));
    const base = { key: r.key, label: r.label, needsExpiry: r.needsExpiry, pendingDocId: pending?.id ?? null, pendingFileId: pending?.fileId ?? null };
    if (approved && (!approved.expiresAt || approved.expiresAt > now)) {
      const soon = approved.expiresAt && approved.expiresAt.getTime() - now.getTime() < 30 * DAY;
      return { ...base, state: soon ? 'EXPIRING' : 'VALID', expiresAt: approved.expiresAt?.toISOString() ?? null, docId: approved.id, note: null };
    }
    if (pending) return { ...base, state: 'IN_REVIEW', expiresAt: pending.expiresAt?.toISOString() ?? null, docId: pending.id, note: null };
    if (latest?.status === 'EXPIRED' || approved) return { ...base, state: 'EXPIRED', expiresAt: (approved ?? latest).expiresAt?.toISOString() ?? null, docId: (approved ?? latest).id, note: null };
    if (latest?.status === 'REJECTED') return { ...base, state: 'REJECTED', expiresAt: null, docId: latest.id, note: latest.note };
    return { ...base, state: 'MISSING', expiresAt: null, docId: null, note: null };
  }

  /**
   * Hourly: expire documents past their date, remind chefs before expiry, pause a chef whose required document
   * expired (setting `chefs.quality.expiredDocumentAction`), and reinstate a document-paused chef once renewals are approved.
   */
  async documentSweep(now = new Date()) {
    const pol = await this.policy();
    const expired = await this.db.update(chefDocuments).set({ status: 'EXPIRED' }).where(and(eq(chefDocuments.status, 'APPROVED'), lt(chefDocuments.expiresAt, now))).returning();
    const profiles = await this.db.select().from(chefProfiles).where(inArray(chefProfiles.status, ['ACTIVE', 'PAUSED']));
    const states = await this.docStatuses(profiles, now);
    let reminded = 0, paused = 0, reinstated = 0, alerted = 0;
    const tiers = [...pol.documentReminderDays].sort((a, b) => a - b);
    for (const p of profiles) {
      const ds = states.get(p.id) || [];
      // reminders before expiry (one per tier; skipped while a renewal is in review)
      for (const d of ds) {
        if (d.state !== 'EXPIRING' && d.state !== 'VALID') continue;
        if (!d.expiresAt || d.pendingDocId) continue;
        const daysLeft = (new Date(d.expiresAt).getTime() - now.getTime()) / DAY;
        const tier = tiers.find((t) => daysLeft <= t);
        if (tier === undefined) continue;
        await this.notify.queue({ userId: p.userId, template: 'chef.document.expiring', payload: { label: d.label, expiresAt: d.expiresAt, days: Math.max(0, Math.ceil(daysLeft)) }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-doc:${d.docId}:${tier}` });
        reminded++;
      }
      // a required document that just expired
      const lapsed = expired.filter((e) => e.applicationId === p.applicationId && ds.some((d) => d.key === e.requirementKey && d.state === 'EXPIRED'));
      if (lapsed.length && p.status === 'ACTIVE') {
        const labels = ds.filter((d) => lapsed.some((l) => l.requirementKey === d.key)).map((d) => d.label).join(', ');
        const pause = pol.expiredDocumentAction === 'PAUSE_CHEF';
        if (pause) { await this.setChefStatus(p, 'PAUSED', 'DOCUMENTS', `Required document expired: ${labels}. Upload a renewal to reopen.`); paused++; }
        await this.event(p.id, { kind: 'DOCUMENT_EXPIRED', source: 'AUTO', note: `${labels} expired${pause ? '; listings paused until a renewal is approved' : ''}`, data: { docIds: lapsed.map((l) => l.id) } });
        await this.alert({ type: 'CHEF_DOCUMENT_EXPIRED', severity: pause ? 'MEDIUM' : 'HIGH', title: `${p.displayName}: ${labels} expired`, detail: pause ? 'The chef was paused automatically until a renewal is approved.' : 'The chef is still selling. Review and pause if needed.', subjectId: p.id, organizationId: p.organizationId, locationId: p.locationId, dedupeKey: `chef-doc-expired:${p.id}`, minutes: 24 * 60 });
        await this.notify.queue({ userId: p.userId, template: 'chef.document.expired', payload: { labels, paused: pause }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-doc-expired:${lapsed.map((l) => l.id).join(',')}` });
        alerted++;
      }
      // renewals approved → lift a document pause
      if (p.status === 'PAUSED' && p.statusCause === 'DOCUMENTS' && ds.every((d) => d.state === 'VALID' || d.state === 'EXPIRING' || d.state === 'MISSING')) {
        if (ds.some((d) => d.state === 'MISSING') && !ds.some((d) => d.state === 'VALID' || d.state === 'EXPIRING')) continue;
        await this.setChefStatus(p, 'ACTIVE', null, null);
        await this.event(p.id, { kind: 'CHEF_REINSTATED', source: 'AUTO', note: 'Renewed documents approved' });
        await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: now, resolution: 'Renewal approved' }).where(and(eq(opsAlerts.dedupeKey, `chef-doc-expired:${p.id}`), sql`${opsAlerts.status} <> 'RESOLVED'`));
        await this.notify.queue({ userId: p.userId, template: 'chef.document.renewed', payload: {}, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-doc-renewed:${p.id}:${now.toISOString().slice(0, 13)}` });
        reinstated++;
      }
    }
    return { expired: expired.length, reminded, paused, reinstated, alerted };
  }

  /** Admin Kitchens: every chef kitchen with its required documents, worst first. */
  async kitchens(user: JwtPayload) {
    this.assertStaff(user, 'chefs.read');
    const profiles = await this.db.select().from(chefProfiles).orderBy(chefProfiles.displayName);
    const states = await this.docStatuses(profiles);
    const locs = new Map((await this.db.select().from(locations).where(eq(locations.chefKitchen, true))).map((l) => [l.id, l]));
    const rank: Record<ChefDocState, number> = { EXPIRED: 0, REJECTED: 1, MISSING: 2, IN_REVIEW: 3, EXPIRING: 4, VALID: 5 };
    const list = profiles.map((p) => {
      const docs = states.get(p.id) || [];
      const l = p.locationId ? locs.get(p.locationId) : undefined;
      const worst = docs.reduce<ChefDocState>((a, d) => (rank[d.state] < rank[a] ? d.state : a), 'VALID');
      const nextExpiry = docs.map((d) => d.expiresAt).filter((x): x is string => !!x && (docs.find((d) => d.expiresAt === x)?.state !== 'EXPIRED')).sort()[0] ?? null;
      return { chefId: p.id, displayName: p.displayName, slug: p.slug, status: p.status, statusCause: p.statusCause, statusReason: p.statusReason, acceptingOrders: p.acceptingOrders, kitchenType: p.kitchenType, region: p.serviceRegion, kitchen: l ? { id: l.id, name: l.name, addressLine1: l.addressLine1, city: l.city, region: l.region, postalCode: l.postalCode, isPaused: l.isPaused } : null, documents: docs, worst, nextExpiry, pendingReviews: docs.filter((d) => d.pendingDocId).length };
    });
    list.sort((a, b) => rank[a.worst] - rank[b.worst] || a.displayName.localeCompare(b.displayName));
    return { kitchens: list, counts: { expired: list.filter((k) => k.worst === 'EXPIRED').length, expiring: list.filter((k) => k.documents.some((d) => d.state === 'EXPIRING')).length, inReview: list.reduce((a, k) => a + k.pendingReviews, 0) } };
  }

  // ───── quality ─────

  /** Per-chef metrics over a window: orders, declines, unconfirmed, cancellations, incidents, food safety, ratings, requests. */
  async metrics(days: number, chefId?: string): Promise<ChefMetrics[]> {
    const pol = await this.policy();
    const since = new Date(Date.now() - days * DAY).toISOString();
    const chefFilter = chefId ? sql`where p.id = ${chefId}` : sql``;
    const r = rows<Record<string, string | number | null | boolean>>(await this.db.execute(sql`
      select p.id, p.display_name, p.slug, p.organization_id, p.status, p.status_cause, p.accepting_orders,
        count(o.id)::int as orders,
        count(o.id) filter (where o.status = 'COMPLETED')::int as completed,
        count(o.id) filter (where o.status = 'REJECTED')::int as declined,
        count(o.id) filter (where o.status = 'REJECTED' and o.reject_reason = ${UNCONFIRMED})::int as unconfirmed,
        count(o.id) filter (where o.status = 'CANCELED')::int as canceled,
        coalesce(sum(o.total_cents) filter (where o.status = 'COMPLETED'), 0)::int as gmv,
        round(avg(extract(epoch from (o.accepted_at - o.created_at)) / 60) filter (where o.accepted_at is not null))::int as avg_accept,
        (select count(*)::int from incidents i where i.organization_id = p.organization_id and i.created_at >= ${since} and i.category <> 'CHARGEBACK' and coalesce(i.responsibility_dispute->>'status', '') <> 'REVERSED') as incidents,
        (select count(*)::int from incidents i join orders oo on oo.id = i.order_id where oo.location_id = p.location_id and i.category = 'FOOD_SAFETY' and i.created_at >= ${since}) as food_safety,
        (select round(avg(rv.rating)::numeric, 2)::float from reviews rv where rv.location_id = p.location_id and rv.status <> 'REJECTED') as rating,
        (select count(*)::int from reviews rv where rv.location_id = p.location_id and rv.status <> 'REJECTED') as ratings,
        (select count(*)::int from chef_requests cr where cr.chef_profile_id = p.id and cr.created_at >= ${since}) as requests,
        (select round(avg(extract(epoch from (cr.first_response_at - cr.created_at)) / 60))::int from chef_requests cr where cr.chef_profile_id = p.id and cr.created_at >= ${since} and cr.first_response_at is not null) as req_response
      from chef_profiles p
      left join orders o on o.location_id = p.location_id and o.created_at >= ${since}
      ${chefFilter}
      group by p.id
      order by p.display_name`));
    return r.map((x) => {
      const orders = Number(x.orders);
      const incidentsN = Number(x.incidents);
      const declinedN = Number(x.declined);
      const judged = orders >= pol.minOrders;
      const incidentRatePct = orders ? Math.round((incidentsN * 1000) / orders) / 10 : null;
      const declineRatePct = orders ? Math.round((declinedN * 1000) / orders) / 10 : null;
      const flags: string[] = [];
      if (Number(x.food_safety) > 0) flags.push('FOOD_SAFETY');
      if (judged && incidentRatePct !== null && incidentRatePct > pol.maxIncidentRatePct) flags.push('INCIDENT_RATE');
      if (judged && declineRatePct !== null && declineRatePct > pol.maxDeclineRatePct) flags.push('DECLINE_RATE');
      return { chefId: String(x.id), displayName: String(x.display_name), slug: String(x.slug), organizationId: String(x.organization_id), status: String(x.status), statusCause: (x.status_cause as string) ?? null, acceptingOrders: !!x.accepting_orders, orders, completed: Number(x.completed), declined: declinedN, unconfirmed: Number(x.unconfirmed), canceled: Number(x.canceled), gmvCents: Number(x.gmv), avgAcceptMinutes: x.avg_accept === null ? null : Number(x.avg_accept), incidents: incidentsN, foodSafety: Number(x.food_safety), incidentRatePct, declineRatePct, rating: x.rating === null ? null : Number(x.rating), ratings: Number(x.ratings), requests: Number(x.requests), avgRequestResponseMinutes: x.req_response === null ? null : Number(x.req_response), flags };
    });
  }

  /**
   * Every 5 minutes: act on food-safety reports for chef orders (suspend the dish, or pause the chef when the dish
   * is unknown), and flag chefs over the incident or decline thresholds (alert + quality record, once a week).
   */
  async qualitySweep(now = new Date()) {
    const pol = await this.policy();
    const reports = await this.db
      .select({ i: incidents, p: chefProfiles, orderId: orders.id })
      .from(incidents)
      .innerJoin(orders, eq(orders.id, incidents.orderId))
      .innerJoin(chefProfiles, eq(chefProfiles.locationId, orders.locationId))
      .where(and(eq(incidents.category, 'FOOD_SAFETY'), sql`${incidents.createdAt} > ${new Date(now.getTime() - 30 * DAY).toISOString()}`, sql`not exists (select 1 from chef_quality_events e where e.incident_id = ${incidents.id})`));
    let acted = 0;
    for (const { i, p, orderId } of reports) {
      let dish: typeof chefDishes.$inferSelect | undefined;
      const itemId = i.menuItemId ?? (await this.singleDishItem(orderId));
      if (itemId) [dish] = await this.db.select().from(chefDishes).where(and(eq(chefDishes.menuItemId, itemId), eq(chefDishes.chefProfileId, p.id))).limit(1);
      const action = pol.foodSafetyAction === 'SUSPEND_DISH' && !dish ? 'PAUSE_CHEF' : pol.foodSafetyAction;
      const kind = action === 'SUSPEND_DISH' ? 'DISH_SUSPENDED' : action === 'PAUSE_CHEF' ? 'CHEF_PAUSED' : 'NOTE';
      const note = action === 'SUSPEND_DISH' ? `Food-safety report: ${dish!.dishName} suspended pending review` : action === 'PAUSE_CHEF' ? 'Food-safety report: listings paused pending review' : 'Food-safety report recorded for review';
      const inserted = await this.db.insert(chefQualityEvents).values({ chefProfileId: p.id, kind, source: 'AUTO', incidentId: i.id, chefDishId: dish?.id ?? null, note }).onConflictDoNothing().returning({ id: chefQualityEvents.id });
      if (!inserted.length) continue;
      if (action === 'SUSPEND_DISH' && dish && dish.reviewStatus === 'PUBLISHED') {
        await this.db.update(chefDishes).set({ reviewStatus: 'SUSPENDED', reviewNote: 'Suspended after a food-safety report while Gutad reviews it' }).where(eq(chefDishes.id, dish.id));
        await this.db.update(menuItems).set({ isActive: false }).where(eq(menuItems.id, dish.menuItemId));
      } else if (action === 'PAUSE_CHEF' && p.status === 'ACTIVE') {
        await this.setChefStatus(p, 'PAUSED', 'QUALITY', 'Paused after a food-safety report while Gutad reviews it');
      }
      await this.audit.log({ organizationId: p.organizationId, actorId: null, action: `chef.quality.auto.${kind.toLowerCase()}`, entityType: 'chef_profile', entityId: p.id, after: { incidentId: i.id, dishId: dish?.id } });
      await this.notify.queue({ userId: p.userId, template: 'chef.quality.action', payload: { kind, label: CHEF_QUALITY_EVENT_LABELS[kind], note }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-quality:${i.id}` });
      acted++;
    }
    // thresholds
    let flagged = 0;
    let autoActions = 0;
    for (const m of await this.metrics(pol.windowDays)) {
      const over = m.flags.filter((f) => f !== 'FOOD_SAFETY');
      if (!over.length) continue;
      const [recent] = await this.db.select({ id: chefQualityEvents.id }).from(chefQualityEvents).where(and(eq(chefQualityEvents.chefProfileId, m.chefId), eq(chefQualityEvents.kind, 'THRESHOLD_BREACH'), sql`${chefQualityEvents.createdAt} > ${new Date(now.getTime() - 7 * DAY).toISOString()}`)).limit(1);
      if (recent) continue;
      const why = [over.includes('INCIDENT_RATE') ? `incidents ${m.incidentRatePct}% (limit ${pol.maxIncidentRatePct}%)` : '', over.includes('DECLINE_RATE') ? `declined or unconfirmed ${m.declineRatePct}% (limit ${pol.maxDeclineRatePct}%)` : ''].filter(Boolean).join('; ');
      await this.event(m.chefId, { kind: 'THRESHOLD_BREACH', source: 'AUTO', note: `Last ${pol.windowDays} days: ${why} over ${m.orders} orders`, data: m });
      await this.alert({ type: 'CHEF_QUALITY', severity: 'MEDIUM', title: `${m.displayName}: quality threshold crossed`, detail: why, subjectId: m.chefId, organizationId: m.organizationId, locationId: null, dedupeKey: `chef-quality:${m.chefId}`, minutes: 24 * 60 });
      const [p] = await this.db.select({ userId: chefProfiles.userId }).from(chefProfiles).where(eq(chefProfiles.id, m.chefId)).limit(1);
      if (p) await this.notify.queue({ userId: p.userId, template: 'chef.quality.action', payload: { kind: 'THRESHOLD_BREACH', label: CHEF_QUALITY_EVENT_LABELS.THRESHOLD_BREACH, note: why }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-threshold:${m.chefId}:${now.toISOString().slice(0, 10)}` });
      flagged++;
      if (await this.autoActOnRates(m.chefId, pol, why, now)) autoActions++;
    }
    return { foodSafetyActions: acted, thresholdFlags: flagged, autoActions };
  }

  /**
   * CN.4 optional automatic action (setting `chefs.quality.autoActionAfterWeeks`): when the chef has been flagged over
   * the rate limits that many weeks in a row (weekly flags at most 10 days apart, counted since their last pause,
   * suspension or reinstatement), pause or suspend them with cause QUALITY. Staff reinstate from Quality.
   */
  private async autoActOnRates(chefId: string, pol: ChefQualityPolicy, why: string, now: Date) {
    const weeks = Math.floor(pol.autoActionAfterWeeks || 0);
    if (weeks < 1) return false;
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, chefId)).limit(1);
    if (!p || p.status !== 'ACTIVE') return false;
    const [reset] = await this.db.select({ at: chefQualityEvents.createdAt }).from(chefQualityEvents).where(and(eq(chefQualityEvents.chefProfileId, chefId), inArray(chefQualityEvents.kind, ['CHEF_PAUSED', 'CHEF_SUSPENDED', 'CHEF_REINSTATED']))).orderBy(desc(chefQualityEvents.createdAt)).limit(1);
    const breaches = await this.db.select({ at: chefQualityEvents.createdAt }).from(chefQualityEvents).where(and(eq(chefQualityEvents.chefProfileId, chefId), eq(chefQualityEvents.kind, 'THRESHOLD_BREACH'), ...(reset ? [sql`${chefQualityEvents.createdAt} > ${reset.at.toISOString()}`] : []))).orderBy(desc(chefQualityEvents.createdAt)).limit(weeks + 1);
    let run = 0;
    let prev = now;
    for (const b of breaches) {
      if (prev.getTime() - b.at.getTime() > 10 * DAY) break;
      run++;
      prev = b.at;
    }
    if (run < weeks) return false;
    const suspend = pol.autoAction === 'SUSPEND_CHEF';
    const kind = suspend ? 'CHEF_SUSPENDED' : 'CHEF_PAUSED';
    const note = `${suspend ? 'Suspended' : 'Paused'} automatically: over the quality limits ${run} week${run === 1 ? '' : 's'} in a row (${why}). Gutad reviews before reinstating.`;
    await this.setChefStatus(p, suspend ? 'SUSPENDED' : 'PAUSED', 'QUALITY', note);
    await this.event(chefId, { kind, source: 'AUTO', note, data: { weeks: run, autoAction: pol.autoAction } });
    await this.alert({ type: 'CHEF_QUALITY', severity: 'HIGH', title: `${p.displayName}: ${suspend ? 'suspended' : 'paused'} automatically for quality`, detail: note, subjectId: chefId, organizationId: p.organizationId, locationId: p.locationId, dedupeKey: `chef-quality-auto:${chefId}:${now.toISOString().slice(0, 10)}`, minutes: 4 * 60 });
    await this.notify.queue({ userId: p.userId, template: 'chef.quality.action', payload: { kind, label: CHEF_QUALITY_EVENT_LABELS[kind], note }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-quality-auto:${chefId}:${now.toISOString().slice(0, 10)}` });
    return true;
  }

  /** When an order has one chef dish, a report about the order is about that dish. */
  private async singleDishItem(orderId: string) {
    const ls = await this.db.selectDistinct({ m: orderLines.menuItemId }).from(orderLines).where(eq(orderLines.orderId, orderId));
    return ls.length === 1 ? ls[0].m : null;
  }

  async quality(user: JwtPayload, days?: number) {
    this.assertStaff(user, 'chefs.read');
    const pol = await this.policy();
    const window = Math.min(365, Math.max(1, days || pol.windowDays));
    const chefs = await this.metrics(window);
    chefs.sort((a, b) => b.flags.length - a.flags.length || (b.incidentRatePct ?? 0) - (a.incidentRatePct ?? 0));
    const events = await this.db.select({ e: chefQualityEvents, name: chefProfiles.displayName }).from(chefQualityEvents).innerJoin(chefProfiles, eq(chefProfiles.id, chefQualityEvents.chefProfileId)).orderBy(desc(chefQualityEvents.createdAt)).limit(50);
    const openFoodSafety = rows<Record<string, unknown>>(await this.db.execute(sql`select i.id, i.status, i.description, i.created_at, o.number, p.display_name as chef, p.id as chef_id, mi.name as item from incidents i join orders o on o.id = i.order_id join chef_profiles p on p.location_id = o.location_id left join menu_items mi on mi.id = i.menu_item_id where i.category = 'FOOD_SAFETY' and i.status in ('OPEN','INVESTIGATING') order by i.created_at desc limit 50`));
    return { windowDays: window, policy: pol, chefs, events: events.map(({ e, name }) => ({ ...e, chefName: name, label: CHEF_QUALITY_EVENT_LABELS[e.kind] ?? e.kind })), openFoodSafety };
  }

  async chefQuality(user: JwtPayload, chefId: string) {
    this.assertStaff(user, 'chefs.read');
    const pol = await this.policy();
    const [m] = await this.metrics(pol.windowDays, chefId);
    if (!m) throw new NotFoundException();
    const events = await this.db.select().from(chefQualityEvents).where(eq(chefQualityEvents.chefProfileId, chefId)).orderBy(desc(chefQualityEvents.createdAt)).limit(100);
    const dishes = await this.db.select({ id: chefDishes.id, dishName: chefDishes.dishName, reviewStatus: chefDishes.reviewStatus }).from(chefDishes).where(eq(chefDishes.chefProfileId, chefId));
    return { metrics: m, events: events.map((e) => ({ ...e, label: CHEF_QUALITY_EVENT_LABELS[e.kind] ?? e.kind })), dishes };
  }

  /** Staff quality action: recorded on the chef's quality record; suspensions and reinstatements are applied. */
  async qualityAction(user: JwtPayload, chefId: string, input: { action: ChefQualityAction; note: string; dishId?: string | null }) {
    this.assertStaff(user, 'chefs.manage');
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, chefId)).limit(1);
    if (!p) throw new NotFoundException();
    let dishName: string | null = null;
    if (input.action === 'DISH_SUSPENDED' || input.action === 'DISH_REINSTATED') {
      if (!input.dishId) throw new BadRequestException({ message: 'Choose the dish', code: 'DISH_REQUIRED' });
      const [d] = await this.db.select().from(chefDishes).where(and(eq(chefDishes.id, input.dishId), eq(chefDishes.chefProfileId, chefId))).limit(1);
      if (!d) throw new NotFoundException('Dish not found for this chef');
      await this.dishes.review(user, d.id, { decision: input.action === 'DISH_SUSPENDED' ? 'SUSPEND' : 'REINSTATE', note: input.note });
      dishName = d.dishName;
    } else if (input.action === 'CHEF_PAUSED' || input.action === 'CHEF_SUSPENDED' || input.action === 'CHEF_REINSTATED') {
      const status = input.action === 'CHEF_PAUSED' ? 'PAUSED' : input.action === 'CHEF_SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
      await this.chefs.adminSetStatus(user, chefId, status, input.note);
      await this.db.update(chefProfiles).set({ statusCause: status === 'ACTIVE' ? null : 'QUALITY' }).where(eq(chefProfiles.id, chefId));
    }
    const note = dishName ? `${dishName}: ${input.note}` : input.note;
    const e = await this.event(chefId, { kind: input.action, source: 'STAFF', note, chefDishId: input.dishId ?? null, createdById: user.sub });
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: `chef.quality.${input.action.toLowerCase()}`, entityType: 'chef_profile', entityId: chefId, after: { dishId: input.dishId }, reason: input.note });
    if (input.action !== 'NOTE') await this.notify.queue({ userId: p.userId, template: 'chef.quality.action', payload: { kind: input.action, label: CHEF_QUALITY_EVENT_LABELS[input.action], note }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `chef-quality:${e.id}` });
    return this.chefQuality(user, chefId);
  }

  // ───── the chef's own view ─────

  /** Documents (with renewal state) and the quality record the chef can see (staff notes are internal). */
  async myCompliance(user: JwtPayload) {
    const p = await this.chefs.myProfile(user);
    const docs = (await this.docStatuses([p])).get(p.id) || [];
    const pol = await this.policy();
    const [m] = await this.metrics(pol.windowDays, p.id);
    const events = await this.db.select().from(chefQualityEvents).where(and(eq(chefQualityEvents.chefProfileId, p.id), sql`${chefQualityEvents.kind} <> 'NOTE'`)).orderBy(desc(chefQualityEvents.createdAt)).limit(50);
    return { status: p.status, statusCause: p.statusCause, statusReason: p.statusReason, documents: docs, metrics: m ? { orders: m.orders, completed: m.completed, declineRatePct: m.declineRatePct, incidentRatePct: m.incidentRatePct, avgAcceptMinutes: m.avgAcceptMinutes, rating: m.rating, ratings: m.ratings, avgRequestResponseMinutes: m.avgRequestResponseMinutes } : null, thresholds: { windowDays: pol.windowDays, minOrders: pol.minOrders, maxIncidentRatePct: pol.maxIncidentRatePct, maxDeclineRatePct: pol.maxDeclineRatePct }, events: events.map((e) => ({ id: e.id, kind: e.kind, label: CHEF_QUALITY_EVENT_LABELS[e.kind] ?? e.kind, note: e.note, createdAt: e.createdAt })) };
  }

  // ───── earnings ─────

  async myEarnings(user: JwtPayload) {
    return this.earnings(await this.chefs.myProfile(user));
  }

  async adminEarnings(user: JwtPayload, chefId: string) {
    if (!isPlatformStaff(user) || !(can(user, 'chefs.read') || can(user, 'finance.read'))) throw new ForbiddenException();
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, chefId)).limit(1);
    if (!p) throw new NotFoundException();
    return this.earnings(p);
  }

  /**
   * Payable balance (paid out weekly), money held until orders are completed, per-order net (food + tax − commission),
   * and adjustments. Prepaid chef orders credit the chef only at completion.
   */
  private async earnings(p: Profile) {
    const payableCents = await this.ledger.balance('MERCHANT_PAYABLE', p.organizationId);
    const net = (o: { subtotalCents: number; taxCents: number; commissionCents: number }) => o.subtotalCents + o.taxCents - o.commissionCents;
    const list = p.locationId ? await this.db.select().from(orders).where(eq(orders.locationId, p.locationId)).orderBy(desc(orders.createdAt)).limit(100) : [];
    const held = list.filter((o) => o.prepaid && !o.recognizedAt && !['CANCELED', 'REJECTED'].includes(o.status));
    const since30 = Date.now() - 30 * DAY;
    const done30 = list.filter((o) => o.recognizedAt && o.recognizedAt.getTime() >= since30);
    const adjustments = await this.db.select({ id: journalEntries.id, createdAt: journalEntries.createdAt, memo: journalEntries.memo, debitCents: journalEntries.debitCents, creditCents: journalEntries.creditCents }).from(journalEntries).where(and(eq(journalEntries.account, 'MERCHANT_PAYABLE'), eq(journalEntries.partyId, p.organizationId), sql`${journalEntries.memo} like 'Adjustment:%'`)).orderBy(desc(journalEntries.createdAt)).limit(50);
    return {
      chefId: p.id,
      organizationId: p.organizationId,
      displayName: p.displayName,
      payableCents,
      heldCents: held.reduce((a, o) => a + net(o), 0),
      heldOrders: held.length,
      last30: { orders: done30.length, foodCents: done30.reduce((a, o) => a + o.subtotalCents, 0), commissionCents: done30.reduce((a, o) => a + o.commissionCents, 0), netCents: done30.reduce((a, o) => a + net(o), 0) },
      orders: list.slice(0, 50).map((o) => ({ id: o.id, number: o.number, status: o.status, createdAt: o.createdAt, scheduledFor: o.scheduledFor, foodCents: o.subtotalCents, taxCents: o.taxCents, commissionCents: o.commissionCents, netCents: ['CANCELED', 'REJECTED'].includes(o.status) ? 0 : net(o), state: ['CANCELED', 'REJECTED'].includes(o.status) ? 'NONE' : o.recognizedAt ? 'EARNED' : 'HELD', recognizedAt: o.recognizedAt })),
      adjustments: adjustments.map((a) => ({ ...a, cents: a.creditCents - a.debitCents, memo: (a.memo || '').replace(/^Adjustment:\s*/, '') })),
    };
  }

  // ───── analytics ─────

  /** Chef Network dashboard: activation funnel, orders and money, fulfilment, requests, popular options, repeat customers. */
  async analytics(user: JwtPayload, days = 30) {
    this.assertStaff(user, 'chefs.read');
    const d = Math.min(365, Math.max(7, days));
    const since = new Date(Date.now() - d * DAY).toISOString();
    const one = async <T,>(q: ReturnType<typeof sql>) => rows<T>(await this.db.execute(q))[0];
    const chefOrders = sql`orders o join locations l on l.id = o.location_id and l.chef_kitchen = true`;
    const funnel = await one<Record<string, number>>(sql`select
        (select count(*)::int from chef_applications) as started,
        (select count(*)::int from chef_applications where status <> 'DRAFT') as submitted,
        (select count(*)::int from chef_applications where status = 'APPROVED') as approved,
        (select count(*)::int from chef_profiles cp join locations l on l.id = cp.location_id join legal_sellers s on s.id = l.legal_seller_id where s.payout_onboarding_state = 'COMPLETE') as payouts,
        (select count(distinct chef_profile_id)::int from chef_dishes where review_status = 'PUBLISHED') as live_dish,
        (select count(distinct p.id)::int from chef_profiles p join orders o on o.location_id = p.location_id where o.status = 'COMPLETED') as first_order,
        (select count(distinct p.id)::int from chef_profiles p join orders o on o.location_id = p.location_id where o.created_at >= ${since}) as active`);
    const money = await one<Record<string, number>>(sql`select count(*)::int as orders,
        count(*) filter (where o.status = 'COMPLETED')::int as completed,
        coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELED','REJECTED')), 0)::bigint::float as gmv,
        coalesce(sum(o.subtotal_cents) filter (where o.status not in ('CANCELED','REJECTED')), 0)::bigint::float as food,
        coalesce(sum(o.commission_cents) filter (where o.status not in ('CANCELED','REJECTED')), 0)::bigint::float as commission,
        coalesce(sum(o.service_fee_cents + o.small_order_fee_cents) filter (where o.status not in ('CANCELED','REJECTED')), 0)::bigint::float as fees,
        count(*) filter (where o.status = 'REJECTED' and o.reject_reason = ${UNCONFIRMED})::int as unconfirmed,
        count(*) filter (where o.status = 'REJECTED')::int as rejected,
        count(*) filter (where o.status = 'CANCELED')::int as canceled,
        round(avg(extract(epoch from (o.accepted_at - o.created_at)) / 60) filter (where o.accepted_at is not null))::int as avg_accept,
        round(avg(extract(epoch from (o.scheduled_for - o.created_at)) / 86400)::numeric, 1)::float as avg_lead_days,
        count(distinct o.user_id)::int as customers,
        count(*) filter (where o.checkout_group_id is not null)::int as multi_chef
      from ${chefOrders} where o.created_at >= ${since}`);
    const repeat = await one<{ repeaters: number; buyers: number }>(sql`select count(*) filter (where n >= 2)::int as repeaters, count(*)::int as buyers from (select o.user_id, count(*) as n from ${chefOrders} where o.user_id is not null and o.status not in ('CANCELED','REJECTED') group by o.user_id) t`);
    const daily = rows<{ day: string; orders: number; gmv: number }>(await this.db.execute(sql`select to_char(date_trunc('day', o.created_at), 'YYYY-MM-DD') as day, count(*)::int as orders, coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELED','REJECTED')), 0)::bigint::float as gmv from ${chefOrders} where o.created_at >= ${since} group by 1 order by 1`));
    const requests = await one<Record<string, number | null>>(sql`select count(*)::int as total,
        count(*) filter (where current_quote_id is not null)::int as quoted,
        count(*) filter (where status = 'ORDERED')::int as ordered,
        count(*) filter (where status = 'EXPIRED')::int as expired,
        count(*) filter (where status = 'DECLINED')::int as declined,
        count(*) filter (where escalated_at is not null)::int as escalated,
        round(avg(extract(epoch from (first_response_at - created_at)) / 60) filter (where first_response_at is not null))::int as avg_response
      from chef_requests where created_at >= ${since}`);
    const modifiers = rows<{ name: string; n: number }>(await this.db.execute(sql`select m->>'name' as name, sum(coalesce((m->>'qty')::int, 1) * ol.quantity)::int as n from ${chefOrders} join order_lines ol on ol.order_id = o.id cross join lateral jsonb_array_elements(ol.modifiers) m where o.created_at >= ${since} and o.status not in ('CANCELED','REJECTED') group by 1 order by 2 desc limit 10`));
    const topDishes = rows<{ name: string; chef: string; n: number; revenue: number }>(await this.db.execute(sql`select cd.dish_name as name, cp.display_name as chef, sum(ol.quantity)::int as n, sum(ol.line_total_cents)::bigint::float as revenue from ${chefOrders} join order_lines ol on ol.order_id = o.id join chef_dishes cd on cd.menu_item_id = ol.menu_item_id join chef_profiles cp on cp.id = cd.chef_profile_id where o.created_at >= ${since} and o.status not in ('CANCELED','REJECTED') group by 1, 2 order by 3 desc limit 10`));
    const chefs = (await this.metrics(d)).filter((m) => m.orders > 0).sort((a, b) => b.gmvCents - a.gmvCents).slice(0, 10);
    const n = (x: unknown) => Number(x || 0);
    const placed = n(money.orders);
    return {
      days: d,
      funnel: { started: n(funnel.started), submitted: n(funnel.submitted), approved: n(funnel.approved), payoutsConnected: n(funnel.payouts), liveDish: n(funnel.live_dish), firstOrder: n(funnel.first_order), activeInWindow: n(funnel.active) },
      orders: { placed, completed: n(money.completed), gmvCents: n(money.gmv), foodCents: n(money.food), customers: n(money.customers), multiChefOrders: n(money.multi_chef), avgLeadDays: money.avg_lead_days === null ? null : Number(money.avg_lead_days) },
      margin: { commissionCents: n(money.commission), customerFeesCents: n(money.fees), gutadRevenueCents: n(money.commission) + n(money.fees), takeRatePct: n(money.gmv) ? Math.round(((n(money.commission) + n(money.fees)) * 1000) / n(money.gmv)) / 10 : null },
      fulfilment: { declinedPct: placed ? Math.round(((n(money.rejected) - n(money.unconfirmed)) * 1000) / placed) / 10 : null, unconfirmedPct: placed ? Math.round((n(money.unconfirmed) * 1000) / placed) / 10 : null, canceledPct: placed ? Math.round((n(money.canceled) * 1000) / placed) / 10 : null, avgAcceptMinutes: money.avg_accept === null ? null : Number(money.avg_accept) },
      requests: { total: n(requests.total), quoted: n(requests.quoted), ordered: n(requests.ordered), expired: n(requests.expired), declined: n(requests.declined), escalated: n(requests.escalated), avgResponseMinutes: requests.avg_response === null ? null : Number(requests.avg_response), quoteToOrderPct: n(requests.quoted) ? Math.round((n(requests.ordered) * 1000) / n(requests.quoted)) / 10 : null },
      repeat: { buyers: n(repeat.buyers), repeaters: n(repeat.repeaters), repeatPct: n(repeat.buyers) ? Math.round((n(repeat.repeaters) * 1000) / n(repeat.buyers)) / 10 : null },
      daily: daily.map((x) => ({ day: x.day, orders: n(x.orders), gmvCents: n(x.gmv) })),
      modifiers: modifiers.map((x) => ({ name: x.name, count: n(x.n) })),
      topDishes: topDishes.map((x) => ({ name: x.name, chef: x.chef, portions: n(x.n), revenueCents: n(x.revenue) })),
      topChefs: chefs.map((m) => ({ chefId: m.chefId, displayName: m.displayName, orders: m.orders, gmvCents: m.gmvCents, rating: m.rating, declineRatePct: m.declineRatePct, incidentRatePct: m.incidentRatePct })),
    };
  }

  // ───── helpers ─────

  private assertStaff(user: JwtPayload, perm: 'chefs.read' | 'chefs.manage') {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    assertCan(user, perm);
  }

  private async setChefStatus(p: Profile, status: 'ACTIVE' | 'PAUSED' | 'SUSPENDED', cause: string | null, reason: string | null) {
    await this.db.update(chefProfiles).set({ status, statusCause: cause, statusReason: reason, ...(status !== 'ACTIVE' ? { acceptingOrders: false } : {}) }).where(eq(chefProfiles.id, p.id));
    if (status !== 'ACTIVE' && p.locationId) await this.db.update(locations).set({ isPaused: true, pausedReason: `Chef ${status.toLowerCase()}: ${reason}` }).where(eq(locations.id, p.locationId));
    await this.audit.log({ organizationId: p.organizationId, actorId: null, action: `chef.status.auto.${status.toLowerCase()}`, entityType: 'chef_profile', entityId: p.id, before: { status: p.status }, after: { status, cause }, reason: reason ?? undefined });
  }

  private async event(chefProfileId: string, e: { kind: string; source: 'AUTO' | 'STAFF'; note: string; data?: unknown; chefDishId?: string | null; createdById?: string | null }) {
    const [row] = await this.db.insert(chefQualityEvents).values({ chefProfileId, kind: e.kind, source: e.source, note: e.note, data: e.data ?? null, chefDishId: e.chefDishId ?? null, createdById: e.createdById ?? null }).returning();
    return row;
  }

  private alert(v: { type: string; severity: string; title: string; detail: string; subjectId: string; organizationId: string | null; locationId: string | null; dedupeKey: string; minutes: number }) {
    return this.db.insert(opsAlerts).values({ type: v.type, severity: v.severity, title: v.title, detail: v.detail, subjectType: 'chef_profile', subjectId: v.subjectId, organizationId: v.organizationId, locationId: v.locationId, dedupeKey: v.dedupeKey, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + v.minutes * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: v.detail.slice(0, 120) }] }).onConflictDoNothing();
  }
}
