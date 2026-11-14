import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { auditLogs, changeRequests, merchantApplications, incidentMessages, incidents, locations, merchantAgreementAcceptances, merchantContracts, merchantDocuments, orders, orgMemberships, organizations, users, stations, kitchens } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { assertCan, assertOrgAccess, can, isPlatformStaff, JwtPayload, MANAGER_ROLES, staffCovers } from '../../common/auth';
import { AdminService } from '../admin/admin.service';
import { CatalogService } from '../catalog/catalog.service';
import { MerchantsService } from '../merchants/merchants.service';
import { LocationsAdminService } from './locations-admin.service';

const STAGES = ['LEAD', 'CONTACTED', 'APPLIED', 'APPROVED', 'ONBOARDING', 'LIVE', 'LOST'] as const;
const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];
const n = (v: unknown) => Number(v || 0);
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** 4 & 5 — applications pipeline, business profile, lifecycle, account managers, change requests, availability, statements, cases, performance. */
@Injectable()
export class MerchantsAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly admin: AdminService,
    private readonly catalog: CatalogService,
    private readonly merchants: MerchantsService,
    private readonly locs: LocationsAdminService,
  ) {}

  // ───── 4.1 applications & pipeline ─────

  async apply(input: { businessName: string; contactName: string; email: string; phone?: string; city?: string; cuisine?: string; locationsCount?: number; website?: string; interest?: string[]; estMonthlyOrders?: number; source?: string }) {
    const [dup] = await this.db.select({ id: merchantApplications.id }).from(merchantApplications).where(and(sql`lower(${merchantApplications.email}) = ${input.email.toLowerCase()}`, sql`lower(${merchantApplications.businessName}) = ${input.businessName.toLowerCase()}`, sql`${merchantApplications.stage} <> 'LOST'`)).limit(1);
    if (dup) return { ok: true, duplicate: true };
    const [row] = await this.db.insert(merchantApplications).values({ ...input, email: input.email.toLowerCase(), interest: input.interest || [], source: input.source || 'WEB', stage: 'APPLIED', history: [{ at: new Date().toISOString(), action: 'APPLIED', by: null }] }).returning();
    return { ok: true, id: row.id };
  }

  async pipeline(user: JwtPayload, q: { stage?: string; ownerId?: string; q?: string }) {
    assertCan(user, 'merchants.read');
    const conds = [];
    if (q.stage) conds.push(eq(merchantApplications.stage, q.stage));
    if (q.ownerId) conds.push(eq(merchantApplications.ownerId, q.ownerId));
    if (q.q) conds.push(sql`(${merchantApplications.businessName} ilike ${'%' + q.q + '%'} or ${merchantApplications.email} ilike ${'%' + q.q + '%'} or ${merchantApplications.city} ilike ${'%' + q.q + '%'})`);
    const list = await this.db.select({ a: merchantApplications, owner: users.email }).from(merchantApplications).leftJoin(users, eq(users.id, merchantApplications.ownerId)).where(conds.length ? and(...conds) : undefined).orderBy(desc(merchantApplications.updatedAt)).limit(500);
    const counts = Object.fromEntries(STAGES.map((s) => [s, list.filter((x) => x.a.stage === s).length]));
    return { counts, items: list.map((x) => ({ ...x.a, ownerEmail: x.owner })) };
  }

  async createLead(user: JwtPayload, input: Parameters<MerchantsAdminService['apply']>[0]) {
    assertCan(user, 'merchants.manage');
    const [row] = await this.db.insert(merchantApplications).values({ ...input, email: input.email.toLowerCase(), interest: input.interest || [], source: input.source || 'OUTBOUND', stage: 'LEAD', ownerId: user.sub, history: [{ at: new Date().toISOString(), action: 'LEAD', by: user.sub, email: user.email }] }).returning();
    return row;
  }

  async updateApplication(user: JwtPayload, id: string, input: { stage?: string; ownerId?: string | null; note?: string; lostReason?: string; estMonthlyOrders?: number }) {
    assertCan(user, 'merchants.manage');
    const [a] = await this.db.select().from(merchantApplications).where(eq(merchantApplications.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    if (input.stage && !STAGES.includes(input.stage as never)) throw new BadRequestException('Unknown stage');
    if (input.stage === 'LOST' && !input.lostReason) throw new BadRequestException('Say why the deal was lost');
    const hist = [...(a.history as unknown[]), { at: new Date().toISOString(), by: user.sub, email: user.email, action: input.stage ? `STAGE ${input.stage}` : input.ownerId !== undefined ? 'OWNER' : 'NOTE', note: input.note || input.lostReason || null }];
    const [row] = await this.db.update(merchantApplications).set({ ...(input.stage ? { stage: input.stage } : {}), ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}), ...(input.lostReason ? { lostReason: input.lostReason } : {}), ...(input.estMonthlyOrders !== undefined ? { estMonthlyOrders: input.estMonthlyOrders } : {}), history: hist }).where(eq(merchantApplications.id, id)).returning();
    return row;
  }

  /** Approve an application: provision the tenant (owner invite), link it, assign the account manager. */
  async convert(user: JwtPayload, id: string) {
    assertCan(user, 'merchants.manage');
    const [a] = await this.db.select().from(merchantApplications).where(eq(merchantApplications.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    if (a.organizationId) throw new ConflictException('Already converted');
    const org = await this.admin.provisionTenant(user, { name: a.businessName, ownerEmail: a.email, kind: 'MERCHANT' });
    await this.db.update(organizations).set({ accountManagerId: a.ownerId || user.sub, website: a.website, contacts: [{ name: a.contactName, role: 'Owner', email: a.email, phone: a.phone }] }).where(eq(organizations.id, org.id));
    await this.db.update(merchantApplications).set({ organizationId: org.id, stage: 'ONBOARDING', history: [...(a.history as unknown[]), { at: new Date().toISOString(), by: user.sub, email: user.email, action: 'CONVERTED', note: org.name }] }).where(eq(merchantApplications.id, id));
    return org;
  }

  // ───── 4.2 profile, 4.8 account manager & progress, 4.7 lifecycle ─────

  async updateProfile(user: JwtPayload, orgId: string, input: { owners?: unknown[]; contacts?: unknown[]; website?: string | null; taxId?: string | null; billingEmail?: string | null }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    const [before] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!before) throw new NotFoundException();
    const total = (input.owners as { ownershipPct?: number }[] | undefined)?.reduce((a, o) => a + (o.ownershipPct || 0), 0) || 0;
    if (total > 100) throw new BadRequestException('Ownership adds up to more than 100%');
    const [row] = await this.db.update(organizations).set(input as never).where(eq(organizations.id, orgId)).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'org.profile', entityType: 'organization', entityId: orgId, before: { owners: before.owners, contacts: before.contacts, taxId: before.taxId }, after: input });
    return row;
  }

  async setAccountManager(user: JwtPayload, orgId: string, userId: string | null) {
    assertCan(user, 'merchants.manage');
    await this.db.update(organizations).set({ accountManagerId: userId }).where(eq(organizations.id, orgId));
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'org.account_manager', entityType: 'organization', entityId: orgId, after: { userId } });
    return { ok: true };
  }

  /**
   * APPROVE → ONBOARDING, ACTIVATE → LIVE, SUSPEND (locations stop selling; their states are saved),
   * REINSTATE (locations restored), TERMINATE (offboarding with commitment checks).
   */
  async lifecycle(user: JwtPayload, orgId: string, action: 'APPROVE' | 'ACTIVATE' | 'SUSPEND' | 'REINSTATE' | 'TERMINATE', reason: string) {
    assertCan(user, 'merchants.manage');
    if (!staffCovers(user, orgId)) throw new ForbiddenException('Outside your access scope');
    if (!reason || reason.trim().length < 5) throw new BadRequestException({ message: 'A reason is required', code: 'REASON_REQUIRED' });
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new NotFoundException();
    const locs = await this.db.select().from(locations).where(eq(locations.organizationId, orgId));
    let result: unknown = null;
    const set = (status: typeof org.status, extra: Partial<typeof organizations.$inferInsert> = {}) => this.db.update(organizations).set({ status, statusReason: reason, statusChangedAt: new Date(), ...extra }).where(eq(organizations.id, orgId));
    if (action === 'APPROVE') {
      if (!['PROSPECT', 'CLAIMED'].includes(org.status)) throw new ConflictException(`Cannot approve from ${org.status}`);
      await set('ONBOARDING');
    } else if (action === 'ACTIVATE') {
      if (['SUSPENDED', 'OFFBOARDED'].includes(org.status)) throw new ConflictException('Reinstate first');
      await set('LIVE');
    } else if (action === 'SUSPEND') {
      if (org.status === 'SUSPENDED') throw new ConflictException('Already suspended');
      await set('SUSPENDED', { suspendedLocationStates: Object.fromEntries(locs.map((l) => [l.id, { status: l.status, isPaused: l.isPaused, pausedReason: l.pausedReason }])) });
      if (locs.length) await this.db.update(locations).set({ status: 'SUSPENDED', isPaused: true, pausedReason: `Suspended: ${reason}` }).where(eq(locations.organizationId, orgId));
    } else if (action === 'REINSTATE') {
      if (org.status !== 'SUSPENDED') throw new ConflictException('Only suspended merchants can be reinstated');
      const saved = (org.suspendedLocationStates || {}) as Record<string, { status: (typeof locations.$inferSelect)['status']; isPaused: boolean; pausedReason: string | null }>;
      for (const l of locs) {
        const s = saved[l.id];
        await this.db.update(locations).set(s ? { status: s.status, isPaused: s.isPaused, pausedReason: s.pausedReason } : { status: l.verifiedAt ? 'VERIFIED' : 'CLAIMED', isPaused: true, pausedReason: 'Reinstated: confirm settings before reopening' }).where(eq(locations.id, l.id));
      }
      const prev = Object.values(saved).some((s) => s.status === 'LIVE') ? 'LIVE' : 'ONBOARDING';
      await set(prev, { suspendedLocationStates: null });
    } else if (action === 'TERMINATE') {
      result = await this.admin.offboard(user, orgId);
      await this.db.update(organizations).set({ statusReason: reason, statusChangedAt: new Date() }).where(eq(organizations.id, orgId));
    }
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: `org.lifecycle.${action.toLowerCase()}`, entityType: 'organization', entityId: orgId, before: { status: org.status }, reason });
    const [after] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return { organization: after, result };
  }

  /** Admin merchant detail: profile, lifecycle history, AM, contracts & acceptances, documents with expiry, members, locations with checklist, cases, changes. */
  async detail(user: JwtPayload, orgId: string) {
    assertCan(user, 'merchants.read');
    if (!staffCovers(user, orgId)) throw new ForbiddenException('Outside your access scope');
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new NotFoundException();
    const [locs, members, contracts, acceptances, docs, history, cases, changes] = await Promise.all([
      this.db.select().from(locations).where(eq(locations.organizationId, orgId)),
      this.db.select({ id: orgMemberships.id, role: orgMemberships.role, locationIds: orgMemberships.locationIds, approvalLimitCents: orgMemberships.approvalLimitCents, email: users.email, name: users.name, userId: users.id }).from(orgMemberships).innerJoin(users, eq(users.id, orgMemberships.userId)).where(eq(orgMemberships.organizationId, orgId)),
      this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version)),
      this.db.select().from(merchantAgreementAcceptances).where(eq(merchantAgreementAcceptances.organizationId, orgId)).orderBy(desc(merchantAgreementAcceptances.acceptedAt)),
      this.db.select({ id: merchantDocuments.id, docType: merchantDocuments.docType, fileName: merchantDocuments.fileName, status: merchantDocuments.status, expiresAt: merchantDocuments.expiresAt, reviewNote: merchantDocuments.reviewNote, createdAt: merchantDocuments.createdAt }).from(merchantDocuments).where(eq(merchantDocuments.organizationId, orgId)).orderBy(desc(merchantDocuments.createdAt)),
      this.db.select({ a: auditLogs, email: users.email }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(and(eq(auditLogs.organizationId, orgId), sql`${auditLogs.action} like 'org.%'`)).orderBy(desc(auditLogs.createdAt)).limit(50),
      this.db.select().from(incidents).where(eq(incidents.organizationId, orgId)).orderBy(desc(incidents.createdAt)).limit(50),
      this.db.select().from(changeRequests).where(eq(changeRequests.organizationId, orgId)).orderBy(desc(changeRequests.createdAt)).limit(50),
    ]);
    const am = org.accountManagerId ? (await this.db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, org.accountManagerId)).limit(1))[0] : null;
    const locDetail = [];
    for (const l of locs) {
      const c = await this.locs.checklist(l);
      locDetail.push({ id: l.id, name: l.name, city: l.city, status: l.status, isPaused: l.isPaused, pausedReason: l.pausedReason, verifiedAt: l.verifiedAt, readinessApprovedAt: l.readinessApprovedAt, progressPct: c.progressPct, requiredOpen: c.requiredOpen });
    }
    const progress = locDetail.length ? Math.round(locDetail.reduce((a, l) => a + l.progressPct, 0) / locDetail.length) : 0;
    return { organization: org, accountManager: am, progressPct: progress, locations: locDetail, members, contracts, acceptances, documents: docs, lifecycle: history.map((h) => ({ ...h.a, actorEmail: h.email })), cases, changeRequests: changes };
  }

  /** Onboarding board: merchants not live yet, with progress and account manager. */
  async onboardingBoard(user: JwtPayload) {
    assertCan(user, 'merchants.read');
    const orgs = (await this.db.select().from(organizations).where(inArray(organizations.status, ['PROSPECT', 'CLAIMED', 'VERIFIED', 'ONBOARDING'])).orderBy(desc(organizations.createdAt)).limit(300)).filter((o) => staffCovers(user, o.id));
    const ams = await this.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, orgs.map((o) => o.accountManagerId).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000'])));
    const out = [];
    for (const o of orgs) {
      const locs = await this.db.select().from(locations).where(eq(locations.organizationId, o.id));
      let pct = 0;
      const open: string[] = [];
      for (const l of locs) { const c = await this.locs.checklist(l); pct += c.progressPct; open.push(...c.requiredOpen); }
      out.push({ id: o.id, name: o.name, status: o.status, createdAt: o.createdAt, accountManager: ams.find((a) => a.id === o.accountManagerId)?.email || null, locations: locs.length, progressPct: locs.length ? Math.round(pct / locs.length) : 0, outstanding: [...new Set(open)] });
    }
    return out;
  }

  /** Worker: documents past expiry become EXPIRED; those expiring in 30 days get one reminder to the owners. */
  async documentExpiry() {
    const expired = await this.db.update(merchantDocuments).set({ status: 'EXPIRED' }).where(and(eq(merchantDocuments.status, 'APPROVED'), isNotNull(merchantDocuments.expiresAt), lt(merchantDocuments.expiresAt, new Date()))).returning({ id: merchantDocuments.id, organizationId: merchantDocuments.organizationId, docType: merchantDocuments.docType });
    const soon = await this.db.select({ id: merchantDocuments.id, organizationId: merchantDocuments.organizationId, docType: merchantDocuments.docType, expiresAt: merchantDocuments.expiresAt }).from(merchantDocuments).where(and(eq(merchantDocuments.status, 'APPROVED'), isNull(merchantDocuments.expiryNotifiedAt), lt(merchantDocuments.expiresAt, new Date(Date.now() + 30 * 86400_000))));
    for (const d of [...expired.map((e) => ({ ...e, expiresAt: null as Date | null, expired: true })), ...soon.map((s) => ({ ...s, expired: false }))]) {
      const owners = await this.db.select({ userId: orgMemberships.userId }).from(orgMemberships).where(and(eq(orgMemberships.organizationId, d.organizationId), inArray(orgMemberships.role, ['MERCHANT_OWNER', 'MERCHANT_MANAGER'])));
      for (const o of owners) await this.notify.queue({ userId: o.userId, template: 'document.expiring', payload: { docType: d.docType.replace(/_/g, ' ').toLowerCase(), expired: d.expired, expiresAt: d.expiresAt }, channels: ['EMAIL', 'IN_APP'], dedupeKey: `doc-expiry:${d.id}:${d.expired ? 'x' : 's'}` });
      if (!d.expired) await this.db.update(merchantDocuments).set({ expiryNotifiedAt: new Date() }).where(eq(merchantDocuments.id, d.id));
    }
    return { expired: expired.length, reminded: soon.length };
  }

  // ───── 5.2 change requests ─────

  async listChanges(user: JwtPayload, q: { status?: string; organizationId?: string }) {
    const staff = isPlatformStaff(user) && can(user, 'merchants.read');
    if (!staff && !q.organizationId) throw new ForbiddenException();
    if (!staff) assertOrgAccess(user, q.organizationId!);
    const conds = [];
    if (q.status) conds.push(eq(changeRequests.status, q.status));
    if (q.organizationId) conds.push(eq(changeRequests.organizationId, q.organizationId));
    const list = await this.db.select({ c: changeRequests, org: organizations.name, email: users.email }).from(changeRequests).innerJoin(organizations, eq(organizations.id, changeRequests.organizationId)).leftJoin(users, eq(users.id, changeRequests.requestedById)).where(conds.length ? and(...conds) : undefined).orderBy(desc(changeRequests.createdAt)).limit(300);
    return list.filter((x) => !staff || staffCovers(user, x.c.organizationId)).map((x) => ({ ...x.c, organizationName: x.org, requestedByEmail: x.email }));
  }

  async reviewChange(user: JwtPayload, id: string, approve: boolean, note?: string) {
    assertCan(user, 'merchants.manage', 'catalog.manage');
    const [c] = await this.db.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    if (c.status !== 'PENDING') throw new ConflictException(`Already ${c.status.toLowerCase()}`);
    if (!approve && (!note || note.trim().length < 3)) throw new BadRequestException('Tell the merchant why');
    if (approve) {
      if (c.kind === 'MENU_ITEM') await this.catalog.updateItem(user, c.targetId, c.changes as never);
      else await this.merchants.updateLocation(user, c.targetId, c.changes as never);
    }
    const [row] = await this.db.update(changeRequests).set({ status: approve ? 'APPROVED' : 'REJECTED', reviewedById: user.sub, reviewNote: note ?? null, reviewedAt: new Date() }).where(eq(changeRequests.id, id)).returning();
    await this.audit.log({ organizationId: c.organizationId, actorId: user.sub, action: approve ? 'change.approve' : 'change.reject', entityType: 'change_request', entityId: id, after: c.changes, reason: note });
    const [req] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, c.requestedById)).limit(1);
    if (req) await this.notify.queue({ userId: req.id, template: 'change.reviewed', payload: { summary: c.summary, approved: approve, note }, channels: ['IN_APP', 'EMAIL'] });
    return row;
  }

  // ───── 5.4 availability across merchants ─────

  async availability(user: JwtPayload) {
    assertCan(user, 'ops.read', 'merchants.read');
    const sold = rows<Record<string, unknown>>(await this.db.execute(sql`select mi.id, mi.name, mi.sold_out_until, m.location_id, l.name as location_name, l.organization_id from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id join locations l on l.id = m.location_id where mi.sold_out order by l.name, mi.name limit 1000`));
    const paused = await this.db.select({ id: locations.id, name: locations.name, organizationId: locations.organizationId, pausedReason: locations.pausedReason, pausedUntil: locations.pausedUntil, status: locations.status }).from(locations).where(eq(locations.isPaused, true));
    const down = await this.db.select({ id: stations.id, code: stations.code, name: stations.name, kitchen: kitchens.name, organizationId: kitchens.organizationId }).from(stations).innerJoin(kitchens, eq(kitchens.id, stations.kitchenId)).where(eq(stations.isAvailable, false));
    return {
      soldOut: sold.filter((x) => staffCovers(user, x.organization_id as string, x.location_id as string)).map((x) => ({ itemId: x.id, name: x.name, until: x.sold_out_until, locationId: x.location_id, locationName: x.location_name })),
      pausedLocations: paused.filter((p) => staffCovers(user, p.organizationId, p.id)),
      stationsDown: down.filter((d) => staffCovers(user, d.organizationId)),
    };
  }

  // ───── 5.5 statement lines per order ─────

  async statementLines(user: JwtPayload, orgId: string, q: { from?: string; to?: string; locationId?: string }) {
    assertOrgAccess(user, orgId, q.locationId, MANAGER_ROLES.concat(['MERCHANT_STAFF']));
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 5 * 60_000); // margin for DB vs API clock drift
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
    const r = rows<Record<string, unknown>>(await this.db.execute(sql`
      select o.id, o.number, o.created_at, o.channel, o.fulfillment_type, o.status, o.subtotal_cents, o.tax_cents, o.tip_cents, o.discount_cents, o.promotion_funder, o.commission_cents, o.total_cents,
        coalesce((select sum(p.processing_fee_cents) from payments p where p.order_id = o.id), 0)::int as processing,
        coalesce((select sum(rf.amount_cents) from refunds rf where rf.order_id = o.id and rf.funder = 'MERCHANT' and rf.status <> 'FAILED'), 0)::int as merchant_refunds,
        coalesce((select sum(rf.amount_cents) from refunds rf where rf.order_id = o.id and rf.status <> 'FAILED'), 0)::int as all_refunds,
        coalesce((select sum(je.credit_cents - je.debit_cents) from journal_entries je where je.order_id = o.id and je.account = 'MERCHANT_PAYABLE'), 0)::int as net
      from orders o where o.organization_id = ${orgId} and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()} ${q.locationId ? sql`and o.location_id = ${q.locationId}` : sql``}
      order by o.created_at desc limit 5000`));
    const lines = r.map((x) => ({ orderId: x.id, number: x.number, createdAt: x.created_at, channel: x.channel, fulfillmentType: x.fulfillment_type, status: x.status, salesCents: n(x.subtotal_cents), taxCents: n(x.tax_cents), tipCents: n(x.tip_cents), merchantFundedDiscountCents: x.promotion_funder === 'MERCHANT' ? n(x.discount_cents) : 0, commissionCents: n(x.commission_cents), processingCents: n(x.processing), merchantRefundsCents: n(x.merchant_refunds), refundsCents: n(x.all_refunds), netPayableCents: n(x.net) }));
    const sum = (k: keyof (typeof lines)[number]) => lines.reduce((a, l) => a + (typeof l[k] === 'number' ? (l[k] as number) : 0), 0);
    return { from, to, totals: { orders: lines.length, salesCents: sum('salesCents'), taxCents: sum('taxCents'), tipCents: sum('tipCents'), commissionCents: sum('commissionCents'), processingCents: sum('processingCents'), merchantRefundsCents: sum('merchantRefundsCents'), netPayableCents: sum('netPayableCents') }, lines };
  }

  async statementCsv(user: JwtPayload, orgId: string, q: { from?: string; to?: string; locationId?: string }) {
    const s = await this.statementLines(user, orgId, q);
    const head = ['number', 'createdAt', 'channel', 'fulfillmentType', 'status', 'salesCents', 'taxCents', 'tipCents', 'merchantFundedDiscountCents', 'commissionCents', 'processingCents', 'merchantRefundsCents', 'netPayableCents'];
    return [head.join(','), ...s.lines.map((l) => head.map((h) => csvCell((l as Record<string, unknown>)[h] instanceof Date ? ((l as Record<string, unknown>)[h] as Date).toISOString() : (l as Record<string, unknown>)[h])).join(','))].join('\n');
  }

  // ───── 5.6 merchant support cases ─────

  async openCase(user: JwtPayload, orgId: string, input: { category: string; description: string; orderId?: string; locationId?: string }) {
    assertOrgAccess(user, orgId, input.locationId);
    if (input.orderId) {
      const [o] = await this.db.select({ organizationId: orders.organizationId }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!o || o.organizationId !== orgId) throw new BadRequestException('Order is not from this merchant');
    }
    const [i] = await this.db.insert(incidents).values({ orderId: input.orderId ?? null, organizationId: orgId, reporterId: user.sub, reporterType: 'MERCHANT', category: input.category, description: input.description, owner: 'PLATFORM' }).returning();
    await this.db.insert(incidentMessages).values({ incidentId: i.id, authorId: user.sub, authorRole: 'MERCHANT', body: input.description });
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'case.open', entityType: 'incident', entityId: i.id, after: { category: input.category } });
    return i;
  }

  /** Cases raised by the merchant and complaints/disputes about the merchant's orders. */
  async cases(user: JwtPayload, orgId: string, status?: string) {
    assertOrgAccess(user, orgId);
    const list = await this.db
      .select({ i: incidents, number: orders.number })
      .from(incidents)
      .leftJoin(orders, eq(orders.id, incidents.orderId))
      .where(and(or(eq(incidents.organizationId, orgId), eq(orders.organizationId, orgId)), status ? eq(incidents.status, status as never) : undefined))
      .orderBy(desc(incidents.createdAt))
      .limit(200);
    return list.map((x) => ({ ...x.i, orderNumber: x.number, aboutMerchant: x.i.reporterType !== 'MERCHANT' }));
  }

  private async caseAccess(user: JwtPayload, incidentId: string) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    const [o] = i.orderId ? await this.db.select({ organizationId: orders.organizationId, userId: orders.userId, locationId: orders.locationId }).from(orders).where(eq(orders.id, i.orderId)).limit(1) : [null];
    const orgId = i.organizationId || o?.organizationId || null;
    const staff = isPlatformStaff(user) && (!orgId || staffCovers(user, orgId));
    const merchant = !!orgId && !!user.orgs?.[orgId];
    const reporter = i.reporterId === user.sub || (!!o && o.userId === user.sub);
    if (!staff && !merchant && !reporter) throw new ForbiddenException();
    return { i, staff, role: staff ? 'STAFF' : merchant ? 'MERCHANT' : user.roles.includes('DRIVER') ? 'DRIVER' : 'CUSTOMER' };
  }

  async caseMessages(user: JwtPayload, incidentId: string) {
    const { staff } = await this.caseAccess(user, incidentId);
    const msgs = await this.db.select({ m: incidentMessages, email: users.email }).from(incidentMessages).leftJoin(users, eq(users.id, incidentMessages.authorId)).where(eq(incidentMessages.incidentId, incidentId)).orderBy(incidentMessages.createdAt);
    return msgs.filter((x) => staff || x.m.visibility !== 'INTERNAL').map((x) => ({ ...x.m, authorEmail: staff ? x.email : x.m.authorRole === 'STAFF' ? 'Gutad support' : x.email }));
  }

  async postCaseMessage(user: JwtPayload, incidentId: string, input: { body: string; visibility?: 'PARTIES' | 'INTERNAL'; templateKey?: string }) {
    const { i, staff, role } = await this.caseAccess(user, incidentId);
    if (input.visibility === 'INTERNAL' && !staff) throw new ForbiddenException('Only staff can write internal notes');
    const [m] = await this.db.insert(incidentMessages).values({ incidentId, authorId: user.sub, authorRole: role, visibility: input.visibility || 'PARTIES', body: input.body, templateKey: input.templateKey ?? null }).returning();
    if (staff && input.visibility !== 'INTERNAL' && i.reporterId && i.reporterId !== user.sub) await this.notify.queue({ userId: i.reporterId, template: 'case.reply', payload: { category: i.category, body: input.body, incidentId }, channels: ['IN_APP', 'EMAIL', 'PUSH'] });
    if (!staff && i.status === 'RESOLVED') await this.db.update(incidents).set({ status: 'APPEALED', appealNote: input.body }).where(eq(incidents.id, incidentId));
    return m;
  }

  // ───── 5.7 merchant performance ─────

  async performance(user: JwtPayload, q: { from?: string; to?: string; regionId?: string }) {
    assertCan(user, 'merchants.read', 'ops.read');
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 5 * 60_000); // margin for DB vs API clock drift
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
    const r = rows<Record<string, unknown>>(await this.db.execute(sql`
      select l.id, l.name, l.organization_id, l.region_id, org.name as org_name,
        count(o.id)::int as orders,
        count(o.id) filter (where o.accepted_at is not null)::int as accepted,
        count(o.id) filter (where o.status = 'REJECTED')::int as rejected,
        count(o.id) filter (where o.status = 'REJECTED' and o.reject_reason = 'Restaurant did not respond')::int as timed_out,
        count(o.id) filter (where o.status = 'CANCELED')::int as canceled,
        avg(extract(epoch from o.accepted_at - o.created_at)) filter (where o.accepted_at is not null and o.scheduled_for is null) as accept_secs,
        avg(extract(epoch from o.ready_at - o.accepted_at)) filter (where o.ready_at is not null) as prep_secs,
        count(o.id) filter (where o.ready_at > o.promise_at)::int as late,
        (select count(*) from incidents i join orders o2 on o2.id = i.order_id where o2.location_id = l.id and i.created_at >= ${from.toISOString()} and i.category in ('MISSING_ITEM','WRONG_ITEM','DAMAGED','QUALITY'))::int as errors
      from locations l join organizations org on org.id = l.organization_id left join orders o on o.location_id = l.id and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()}
      ${q.regionId ? sql`where l.region_id = ${q.regionId}` : sql``}
      group by l.id, org.name order by orders desc limit 1000`));
    return r
      .filter((x) => staffCovers(user, x.organization_id as string, x.id as string))
      .map((x) => {
        const orders_ = n(x.orders);
        const decided = n(x.accepted) + n(x.rejected);
        return { locationId: x.id, name: x.name, merchant: x.org_name, orders: orders_, acceptanceRate: decided ? n(x.accepted) / decided : null, timedOut: n(x.timed_out), cancellationRate: orders_ ? (n(x.canceled) + n(x.rejected)) / orders_ : null, avgAcceptSeconds: x.accept_secs ? Math.round(n(x.accept_secs)) : null, avgPrepMinutes: x.prep_secs ? Math.round(n(x.prep_secs) / 60) : null, lateRate: n(x.accepted) ? n(x.late) / n(x.accepted) : null, errorRate: orders_ ? n(x.errors) / orders_ : null };
      });
  }
}

