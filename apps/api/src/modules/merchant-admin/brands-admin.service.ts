import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { brandReviews, brands, kitchenBrands, kitchens, locations, menus, organizations, regions, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { assertCan, assertOrgAccess, can, isPlatformStaff, JwtPayload, MANAGER_ROLES, staffCovers } from '../../common/auth';
import { brandBlockReason } from '../../common/brand-rules';
import { AlertsService } from '../ops/alerts.service';

export interface RoyaltyRule { type: 'BPS' | 'PER_ITEM' | 'TIERED'; bps?: number; cents?: number; tiers?: { uptoCents: number | null; bps: number }[]; channel?: string; minGuaranteeCents?: number }
const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];
const n = (v: unknown) => Number(v || 0);

/** Royalty for a period from the brand's rules (falls back to the flat `royaltyBps`). */
export function computeRoyalty(rules: RoyaltyRule[], flatBps: number, byChannel: { channel: string; salesCents: number; units: number }[]) {
  const total = byChannel.reduce((a, c) => a + c.salesCents, 0);
  if (!rules.length) return { royaltyCents: Math.round((total * flatBps) / 10000), lines: [{ rule: `${flatBps / 100}% of sales`, cents: Math.round((total * flatBps) / 10000) }] };
  const lines: { rule: string; cents: number }[] = [];
  let min = 0;
  for (const r of rules) {
    const scope = r.channel ? byChannel.filter((c) => c.channel === r.channel) : byChannel;
    const sales = scope.reduce((a, c) => a + c.salesCents, 0);
    const units = scope.reduce((a, c) => a + c.units, 0);
    const label = r.channel ? ` (${r.channel.toLowerCase()})` : '';
    if (r.type === 'BPS') lines.push({ rule: `${(r.bps || 0) / 100}% of sales${label}`, cents: Math.round((sales * (r.bps || 0)) / 10000) });
    if (r.type === 'PER_ITEM') lines.push({ rule: `$${((r.cents || 0) / 100).toFixed(2)} per item${label}`, cents: units * (r.cents || 0) });
    if (r.type === 'TIERED') {
      let left = sales, floor = 0, cents = 0;
      for (const t of r.tiers || []) {
        const cap = t.uptoCents === null ? Infinity : t.uptoCents - floor;
        const take = Math.max(0, Math.min(left, cap));
        cents += Math.round((take * t.bps) / 10000);
        left -= take;
        floor = t.uptoCents ?? floor;
        if (left <= 0) break;
      }
      lines.push({ rule: `tiered${label}`, cents });
    }
    min = Math.max(min, r.minGuaranteeCents || 0);
  }
  let royalty = lines.reduce((a, l) => a + l.cents, 0);
  if (min > royalty) { lines.push({ rule: 'minimum guarantee top-up', cents: min - royalty }); royalty = min; }
  return { royaltyCents: royalty, lines };
}

/** 6 — brand ownership & rights, territories, channels, royalty rules, assets, reviews, statements, stop-sell. */
@Injectable()
export class BrandsAdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly alerts: AlertsService) {}

  private async brand(id: string) {
    const [b] = await this.db.select().from(brands).where(eq(brands.id, id)).limit(1);
    if (!b) throw new NotFoundException('Brand not found');
    return b;
  }

  async list(user: JwtPayload) {
    assertCan(user, 'catalog.read', 'merchants.read');
    const list = await this.db.select({ b: brands, org: organizations.name }).from(brands).innerJoin(organizations, eq(organizations.id, brands.organizationId)).orderBy(brands.name);
    const kb = await this.db.select({ brandId: kitchenBrands.brandId, kitchen: kitchens.name, isActive: kitchenBrands.isActive }).from(kitchenBrands).innerJoin(kitchens, eq(kitchens.id, kitchenBrands.kitchenId));
    return list.filter((x) => staffCovers(user, x.b.organizationId)).map((x) => ({ ...x.b, organizationName: x.org, kitchens: kb.filter((k) => k.brandId === x.b.id).map((k) => ({ name: k.kitchen, isActive: k.isActive })), blockedReason: brandBlockReason(x.b, null) }));
  }

  async detail(user: JwtPayload, id: string) {
    const b = await this.brand(id);
    assertOrgAccess(user, b.organizationId);
    const [reviews, menuRows, kb, regs] = await Promise.all([
      this.db.select({ r: brandReviews, email: users.email }).from(brandReviews).leftJoin(users, eq(users.id, brandReviews.reviewerId)).where(eq(brandReviews.brandId, id)).orderBy(desc(brandReviews.createdAt)).limit(100),
      this.db.select({ id: menus.id, name: menus.name, locationId: menus.locationId, location: locations.name, regionId: locations.regionId, channels: menus.channels, isActive: menus.isActive }).from(menus).innerJoin(locations, eq(locations.id, menus.locationId)).where(eq(menus.brandId, id)),
      this.db.select({ kitchenId: kitchenBrands.kitchenId, kitchen: kitchens.name, isActive: kitchenBrands.isActive }).from(kitchenBrands).innerJoin(kitchens, eq(kitchens.id, kitchenBrands.kitchenId)).where(eq(kitchenBrands.brandId, id)),
      this.db.select().from(regions),
    ]);
    return { brand: b, territories: regs.filter((r) => b.territoryRegionIds.includes(r.id)), menus: menuRows.map((m) => ({ ...m, blockedReason: brandBlockReason(b, m.regionId) })), kitchens: kb, reviews: reviews.map((x) => ({ ...x.r, reviewerEmail: x.email })), blockedReason: brandBlockReason(b, null) };
  }

  /** Rights, territories, contract dates and royalty rules are Gutad's to set; assets and standards the brand owner may edit. */
  async update(user: JwtPayload, id: string, input: Partial<{ ownershipType: string; ownerName: string | null; operatingRights: string | null; territoryRegionIds: string[]; contractStart: string | null; contractEnd: string | null; rightsStatus: string; rightsNote: string | null; authorizedChannels: string[]; royaltyRules: RoyaltyRule[]; royaltyBps: number; presentationStandards: string | null; assets: unknown[]; description: string | null; logoUrl: string | null }>) {
    const b = await this.brand(id);
    const commercial = ['ownershipType', 'ownerName', 'operatingRights', 'territoryRegionIds', 'contractStart', 'contractEnd', 'rightsStatus', 'rightsNote', 'authorizedChannels', 'royaltyRules', 'royaltyBps'].some((k) => k in input);
    if (commercial) {
      assertCan(user, 'merchants.manage', 'catalog.manage');
      if (!staffCovers(user, b.organizationId)) throw new ForbiddenException('Outside your access scope');
    } else assertOrgAccess(user, b.organizationId, null, MANAGER_ROLES);
    if (input.ownershipType && !['COMPANY_OWNED', 'LICENSED', 'INDEPENDENT', 'CREATOR'].includes(input.ownershipType)) throw new BadRequestException('Unknown ownership type');
    if (input.rightsStatus && !['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(input.rightsStatus)) throw new BadRequestException('Unknown rights status');
    if (input.rightsStatus && input.rightsStatus !== 'ACTIVE' && !input.rightsNote) throw new BadRequestException('Say why sales are stopped');
    const { contractStart, contractEnd, ...rest } = input;
    const set = { ...rest, ...(contractStart !== undefined ? { contractStart: contractStart ? new Date(contractStart) : null } : {}), ...(contractEnd !== undefined ? { contractEnd: contractEnd ? new Date(contractEnd) : null } : {}) };
    const [row] = await this.db.update(brands).set(set as never).where(eq(brands.id, id)).returning();
    await this.audit.log({ organizationId: b.organizationId, actorId: user.sub, action: commercial ? 'brand.rights' : 'brand.presentation', entityType: 'brand', entityId: id, before: Object.fromEntries(Object.keys(input).map((k) => [k, (b as Record<string, unknown>)[k]])), after: input, reason: input.rightsNote ?? undefined });
    return row;
  }

  async authorizeKitchen(user: JwtPayload, brandId: string, kitchenId: string, isActive: boolean) {
    assertCan(user, 'merchants.manage', 'catalog.manage');
    const b = await this.brand(brandId);
    await this.db.insert(kitchenBrands).values({ kitchenId, brandId, isActive }).onConflictDoUpdate({ target: [kitchenBrands.kitchenId, kitchenBrands.brandId], set: { isActive } });
    await this.audit.log({ organizationId: b.organizationId, actorId: user.sub, action: 'brand.kitchen', entityType: 'brand', entityId: brandId, after: { kitchenId, isActive } });
    return { ok: true };
  }

  // ───── 6.6 reviews ─────

  async addReview(user: JwtPayload, brandId: string, input: { kind: string; subjectType?: string; subjectId?: string; locationId?: string; score?: number; result: 'PASS' | 'FAIL' | 'NEEDS_WORK'; notes?: string }) {
    if (!can(user, 'culinary.manage') && !can(user, 'catalog.manage')) throw new ForbiddenException('Culinary reviews are done by Gutad culinary staff');
    const b = await this.brand(brandId);
    const [row] = await this.db.insert(brandReviews).values({ brandId, kind: input.kind, subjectType: input.subjectType ?? null, subjectId: input.subjectId ?? null, locationId: input.locationId ?? null, score: input.score ?? null, result: input.result, notes: input.notes ?? null, reviewerId: user.sub }).returning();
    await this.audit.log({ organizationId: b.organizationId, actorId: user.sub, action: 'brand.review', entityType: 'brand', entityId: brandId, after: row });
    return row;
  }

  // ───── 6.7 partner statement ─────

  async statement(user: JwtPayload, brandId: string, q: { from?: string; to?: string }) {
    const b = await this.brand(brandId);
    assertOrgAccess(user, b.organizationId);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 5 * 60_000); // margin for DB vs API clock drift
    const from = q.from ? new Date(q.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    const byChannel = rows<Record<string, unknown>>(await this.db.execute(sql`select o.channel, sum(ol.line_total_cents)::bigint as sales, sum(ol.quantity)::int as units, count(distinct o.id)::int as orders from order_lines ol join orders o on o.id = ol.order_id where ol.brand_id = ${brandId} and o.status in ('COMPLETED','COLLECTED') and ol.status not in ('CREDITED','UNAVAILABLE') and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()} group by o.channel`)).map((x) => ({ channel: x.channel as string, salesCents: n(x.sales), units: n(x.units), orders: n(x.orders) }));
    const byLocation = rows<Record<string, unknown>>(await this.db.execute(sql`select l.name, sum(ol.line_total_cents)::bigint as sales, sum(ol.quantity)::int as units from order_lines ol join orders o on o.id = ol.order_id join locations l on l.id = o.location_id where ol.brand_id = ${brandId} and o.status in ('COMPLETED','COLLECTED') and ol.status not in ('CREDITED','UNAVAILABLE') and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()} group by l.name order by sales desc`)).map((x) => ({ location: x.name as string, salesCents: n(x.sales), units: n(x.units) }));
    const topItems = rows<Record<string, unknown>>(await this.db.execute(sql`select ol.name, sum(ol.quantity)::int as units, sum(ol.line_total_cents)::bigint as sales from order_lines ol join orders o on o.id = ol.order_id where ol.brand_id = ${brandId} and o.status in ('COMPLETED','COLLECTED') and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()} group by ol.name order by sales desc limit 10`)).map((x) => ({ name: x.name as string, units: n(x.units), salesCents: n(x.sales) }));
    const quality = rows<Record<string, unknown>>(await this.db.execute(sql`select count(*)::int as n, avg(score)::float as avg, count(*) filter (where result = 'FAIL')::int as fails from brand_reviews where brand_id = ${brandId} and created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}`))[0];
    const roy = computeRoyalty(b.royaltyRules as RoyaltyRule[], b.royaltyBps, byChannel);
    const sales = byChannel.reduce((a, c) => a + c.salesCents, 0);
    return { brand: { id: b.id, name: b.name, ownershipType: b.ownershipType, ownerName: b.ownerName }, period: { from, to }, salesCents: sales, units: byChannel.reduce((a, c) => a + c.units, 0), orders: byChannel.reduce((a, c) => a + c.orders, 0), byChannel, byLocation, topItems, royalty: roy, quality: { reviews: n(quality?.n), avgScore: quality?.avg ? Number(quality.avg) : null, fails: n(quality?.fails) } };
  }

  // ───── 6.8 stop-sell ─────

  /** Worker: brands whose contract has ended move to EXPIRED (their menus stop selling at once) and raise an alert. */
  async expireRights() {
    const due = await this.db.update(brands).set({ rightsStatus: 'EXPIRED', rightsNote: 'Contract end date passed' }).where(and(eq(brands.rightsStatus, 'ACTIVE'), isNotNull(brands.contractEnd), lt(brands.contractEnd, new Date()))).returning();
    for (const b of due) {
      await this.audit.log({ organizationId: b.organizationId, action: 'brand.rights_expired', entityType: 'brand', entityId: b.id, after: { contractEnd: b.contractEnd } });
      await this.alerts.raise({ dedupeKey: `brand-expired:${b.id}`, type: 'MANUAL', severity: 'HIGH', title: `Brand ${b.name}: rights expired, sales stopped`, detail: 'Renew the contract or remove the menus.', subjectType: 'brand', subjectId: b.id, organizationId: b.organizationId, ownerRole: 'OPERATIONS' });
    }
    return { expired: due.length };
  }

  async ownedBrands(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(brands).where(eq(brands.organizationId, orgId));
  }

  isStaff(user: JwtPayload) { return isPlatformStaff(user); }
}

