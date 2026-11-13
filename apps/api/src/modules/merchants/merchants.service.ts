import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq, ilike, isNotNull, or } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import {
  brands,
  legalSellers,
  locations,
  openingHours,
  orgMemberships,
  organizations,
  publications,
  referralEvents,
  reservationPolicies,
  users,
} from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES, RoleName, staffCovers } from '../../common/auth';
import { isStaffRole } from '@gutad/shared';
import { ApprovalsService } from '../security/approvals.service';
import { shortCode, slugify, token } from '../../common/utils';
import { loadConfig } from '../../config/config';
import { RedisService } from '../../core/redis.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { EntitlementsService } from '../entitlements/entitlements.service';

type Fleet = 'MERCHANT' | 'PARTNER' | 'PLATFORM';

@Injectable()
export class MerchantsService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly redis: RedisService, private readonly onboarding: OnboardingService, private readonly entitlements: EntitlementsService, private readonly approvals: ApprovalsService) {}

  onModuleInit() {
    this.approvals.register('BANK_ACCOUNT_CHANGE', {
      execute: async (req) => {
        const p = req.payload as { sellerId: string; changes?: Record<string, string | null>; reconnect?: boolean };
        if (p.reconnect) {
          await this.db.update(legalSellers).set({ payoutOnboardingState: 'PENDING' }).where(eq(legalSellers.id, p.sellerId));
          await this.audit.log({ organizationId: req.organizationId, actorId: req.decidedById, action: 'seller.payout_reconnect_approved', entityType: 'legal_seller', entityId: p.sellerId, reason: req.reason });
          return { sellerId: p.sellerId, next: 'Merchant reconnects the payout account from Finance' };
        }
        p.changes = p.changes || {};
        const [before] = await this.db.select().from(legalSellers).where(eq(legalSellers.id, p.sellerId)).limit(1);
        const [row] = await this.db.update(legalSellers).set(p.changes).where(eq(legalSellers.id, p.sellerId)).returning();
        await this.audit.log({ organizationId: req.organizationId, actorId: req.decidedById, action: 'seller.bank_change', entityType: 'legal_seller', entityId: p.sellerId, before: { beneficiaryName: before?.beneficiaryName, bankLast4: before?.bankLast4, taxId: before?.taxId }, after: p.changes, reason: req.reason });
        return { id: row.id, beneficiaryName: row.beneficiaryName, bankLast4: row.bankLast4 };
      },
    });
  }

  /**
   * Bank and beneficiary details never change on one person's say-so: the change becomes a BANK_ACCOUNT_CHANGE
   * request that a different person with `finance.approve` must approve before it applies.
   */
  async requestBankChange(user: JwtPayload, sellerId: string, input: { beneficiaryName?: string; bankLast4?: string; taxId?: string; reason: string }) {
    const [seller] = await this.db.select().from(legalSellers).where(eq(legalSellers.id, sellerId)).limit(1);
    if (!seller) throw new NotFoundException();
    assertOrgAccess(user, seller.organizationId, null, MANAGER_ROLES);
    const changes: Record<string, string | null> = {};
    for (const k of ['beneficiaryName', 'bankLast4', 'taxId'] as const) if (input[k] !== undefined && input[k] !== seller[k]) changes[k] = input[k] ?? null;
    if (!Object.keys(changes).length) return { status: 'NO_CHANGE' };
    return this.approvals.submit(user, { kind: 'BANK_ACCOUNT_CHANGE', summary: `Payout details for ${seller.legalName}: ${Object.keys(changes).join(', ')}`, organizationId: seller.organizationId, subjectType: 'legal_seller', subjectId: seller.id, payload: { sellerId: seller.id, changes }, reason: input.reason, dedupeKey: `bank:${seller.id}` });
  }

  // ───── organizations & membership (01/02/30) ─────

  async createOrganization(user: JwtPayload, input: { name: string; kind?: string; taxId?: string; billingEmail?: string }) {
    const slug = `${slugify(input.name)}-${shortCode(4).toLowerCase()}`;
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.name, slug, kind: input.kind || 'MERCHANT', taxId: input.taxId ?? null, billingEmail: input.billingEmail ?? user.email, status: 'CLAIMED' })
        .returning();
      await tx.insert(orgMemberships).values({ userId: user.sub, organizationId: org.id, role: 'MERCHANT_OWNER', acceptedAt: new Date() });
      await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'org.create', entityType: 'organization', entityId: org.id, after: org }, tx);
      return org;
    });
  }

  async listMyOrganizations(user: JwtPayload) {
    if (isPlatformStaff(user)) {
      const all = await this.db.select().from(organizations).limit(1000);
      return all.filter((o) => staffCovers(user, o.id)).slice(0, 200);
    }
    const ids = Object.keys(user.orgs || {});
    if (!ids.length) return [];
    return this.db.select().from(organizations).where(or(...ids.map((id) => eq(organizations.id, id))));
  }

  async getOrganization(user: JwtPayload, id: string) {
    assertOrgAccess(user, id);
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new NotFoundException();
    const locs = await this.db.select().from(locations).where(eq(locations.organizationId, id));
    const sellers = await this.db.select().from(legalSellers).where(eq(legalSellers.organizationId, id));
    const brandRows = await this.db.select().from(brands).where(eq(brands.organizationId, id));
    const members = await this.db
      .select({ id: orgMemberships.id, role: orgMemberships.role, locationIds: orgMemberships.locationIds, approvalLimitCents: orgMemberships.approvalLimitCents, userId: users.id, email: users.email, name: users.name, acceptedAt: orgMemberships.acceptedAt })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(eq(orgMemberships.organizationId, id));
    return { ...org, locations: locs, legalSellers: sellers, brands: brandRows, members };
  }

  /** Invite staff with a limited, location-scoped role. Creates a guest user record if needed. */
  async inviteMember(user: JwtPayload, orgId: string, input: { email: string; role: RoleName; locationIds?: string[]; approvalLimitCents?: number }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    if (isStaffRole(input.role) && input.role !== 'DISPATCHER') throw new ForbiddenException('Cannot grant platform roles');
    const email = input.email.toLowerCase();
    let [u] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const alreadyMember = u ? (await this.db.select({ id: orgMemberships.id }).from(orgMemberships).where(and(eq(orgMemberships.userId, u.id), eq(orgMemberships.organizationId, orgId))).limit(1)).length > 0 : false;
    if (!alreadyMember && !isPlatformStaff(user)) await this.entitlements.assertLimit(orgId, 'team_members');
    if (!u) [u] = await this.db.insert(users).values({ email, isGuest: true }).returning();
    const [m] = await this.db
      .insert(orgMemberships)
      .values({ userId: u.id, organizationId: orgId, role: input.role, locationIds: input.locationIds || [], approvalLimitCents: input.approvalLimitCents || 0 })
      .onConflictDoUpdate({
        target: [orgMemberships.userId, orgMemberships.organizationId, orgMemberships.role],
        set: { locationIds: input.locationIds || [], approvalLimitCents: input.approvalLimitCents || 0 },
      })
      .returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'member.invite', entityType: 'membership', entityId: m.id, after: m });
    return m;
  }

  async removeMember(user: JwtPayload, orgId: string, membershipId: string) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    await this.db.delete(orgMemberships).where(and(eq(orgMemberships.id, membershipId), eq(orgMemberships.organizationId, orgId)));
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'member.remove', entityType: 'membership', entityId: membershipId });
    return { ok: true };
  }

  // ───── legal sellers & brands (02) ─────

  async upsertLegalSeller(user: JwtPayload, orgId: string, input: { id?: string; legalName: string; taxId?: string; country?: string; beneficiaryName?: string; billingContact?: string }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    if (input.id) {
      const [cur] = await this.db.select().from(legalSellers).where(and(eq(legalSellers.id, input.id), eq(legalSellers.organizationId, orgId))).limit(1);
      if (!cur) throw new NotFoundException();
      const { beneficiaryName, taxId, ...rest } = input;
      const sensitive = (beneficiaryName !== undefined && beneficiaryName !== cur.beneficiaryName) || (taxId !== undefined && taxId !== cur.taxId);
      const [row] = await this.db.update(legalSellers).set(cur.payoutAccountId ? rest : input).where(eq(legalSellers.id, input.id)).returning();
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'seller.update', entityType: 'legal_seller', entityId: row.id, before: cur, after: row });
      if (sensitive && cur.payoutAccountId) {
        const r = await this.requestBankChange(user, cur.id, { beneficiaryName, taxId, reason: 'Merchant updated legal seller details' });
        return { ...row, approval: 'approval' in r ? r.approval : null };
      }
      return row;
    }
    const [row] = await this.db.insert(legalSellers).values({ ...input, organizationId: orgId, payoutProvider: loadConfig().PAYMENT_PROVIDER }).returning();
    return row;
  }

  async upsertBrand(user: JwtPayload, orgId: string, input: { id?: string; name: string; legalSellerId?: string; description?: string; logoUrl?: string; royaltyBps?: number; contentRightsOk?: boolean }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    if (input.id) {
      const [before] = await this.db.select().from(brands).where(eq(brands.id, input.id)).limit(1);
      const [row] = await this.db.update(brands).set(input).where(and(eq(brands.id, input.id), eq(brands.organizationId, orgId))).returning();
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'brand.update', entityType: 'brand', entityId: input.id, before, after: row });
      return row;
    }
    const [row] = await this.db.insert(brands).values({ ...input, organizationId: orgId, slug: `${slugify(input.name)}-${shortCode(3).toLowerCase()}` }).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'brand.create', entityType: 'brand', entityId: row.id, after: row });
    return row;
  }

  // ───── locations (02) ─────

  async createLocation(user: JwtPayload, orgId: string, input: Partial<typeof locations.$inferInsert> & { name: string; addressLine1: string; city: string; region: string; postalCode: string }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    // duplicate listing check: same name + postal code
    const dupes = await this.db
      .select({ id: locations.id, organizationId: locations.organizationId })
      .from(locations)
      .where(and(ilike(locations.name, input.name), eq(locations.postalCode, input.postalCode)));
    const foreignDupe = dupes.find((d) => d.organizationId !== orgId);
    if (foreignDupe) throw new ConflictException(`A listing for this venue already exists (${foreignDupe.id}). Claim it instead.`);
    const slug = `${slugify(input.name)}-${slugify(input.city)}-${shortCode(3).toLowerCase()}`;
    if (!isPlatformStaff(user)) {
      // who delivers is set by Gutad; merchants request a change (see requestDeliveryFleet)
      delete input.deliveryFleet;
      delete input.platformOperated;
      await this.entitlements.assertLimit(orgId, 'locations');
    }
    return this.db.transaction(async (tx) => {
      const [loc] = await tx
        .insert(locations)
        .values({ ...input, organizationId: orgId, slug, claimedByUserId: user.sub, status: 'CLAIMED', currency: input.currency || loadConfig().DEFAULT_CURRENCY, timezone: input.timezone || loadConfig().DEFAULT_TIMEZONE })
        .returning();
      await tx.insert(reservationPolicies).values({ locationId: loc.id });
      // default publication: marketplace listing + direct order link + booking widget
      await tx.insert(publications).values([
        { locationId: loc.id, kind: 'LISTING', channel: 'MARKETPLACE', slug: `l-${loc.slug}` },
        { locationId: loc.id, kind: 'ORDER_LINK', channel: 'DIRECT', slug: `order-${loc.slug}` },
        { locationId: loc.id, kind: 'BOOKING_WIDGET', channel: 'WIDGET', slug: `book-${loc.slug}` },
        { locationId: loc.id, kind: 'QR', channel: 'QR', slug: `qr-${loc.slug}` },
      ]);
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'location.create', entityType: 'location', entityId: loc.id, after: loc }, tx);
      return loc;
    });
  }

  /** Claim an unclaimed (PROSPECT) listing created by platform sales. */
  async claimLocation(user: JwtPayload, locationId: string, orgId: string) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (loc.status !== 'PROSPECT') throw new ConflictException('Listing already claimed');
    const [row] = await this.db.update(locations).set({ organizationId: orgId, status: 'CLAIMED', claimedByUserId: user.sub }).where(eq(locations.id, locationId)).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'location.claim', entityType: 'location', entityId: locationId, before: loc, after: row });
    return row;
  }

  /** Platform staff verify the operator; required before going LIVE. */
  async verifyLocation(user: JwtPayload, locationId: string, verified: boolean) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    if (verified) {
      const loc = await this.requireLocation(locationId);
      const missing = await this.onboarding.blockers(loc.organizationId);
      if (missing.length) throw new BadRequestException(`Onboarding incomplete: ${missing.join('; ')}`);
    }
    const [row] = await this.db
      .update(locations)
      .set({ status: verified ? 'VERIFIED' : 'CLAIMED', verifiedAt: verified ? new Date() : null })
      .where(eq(locations.id, locationId))
      .returning();
    await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'location.verify', entityType: 'location', entityId: locationId, after: { verified } });
    return row;
  }

  async updateLocation(user: JwtPayload, locationId: string, input: Partial<typeof locations.$inferInsert>) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const { id: _id, organizationId: _o, slug: _s, status: _st, verifiedAt: _v, deliveryFleetRequested: _fr, deliveryFleetRequestedAt: _fra, deliveryFleetRequestNote: _frn, ...safe } = input;
    if (!isPlatformStaff(user)) {
      // the delivery option and the Made at Gutad designation are controlled by platform staff
      if (safe.deliveryFleet !== undefined && safe.deliveryFleet !== loc.deliveryFleet) throw new ForbiddenException('Changing who delivers needs Gutad approval. Submit a request from Settings > Delivery.');
      delete safe.deliveryFleet;
      delete safe.platformOperated;
    }
    const [row] = await this.db.update(locations).set(safe).where(eq(locations.id, locationId)).returning();
    await this.redis.del(`loc:${loc.slug}`);
    await this.redis.del(`loc:${loc.id}`);
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'location.update', entityType: 'location', entityId: locationId, before: loc, after: row });
    return row;
  }

  // ───── delivery option approval (who delivers) ─────

  /** Merchant asks to change who delivers its orders. Takes effect only after platform staff approve it. */
  async requestDeliveryFleet(user: JwtPayload, locationId: string, fleet: Fleet, note?: string) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    if (fleet === loc.deliveryFleet) throw new BadRequestException('That is already your delivery option');
    const [row] = await this.db.update(locations).set({ deliveryFleetRequested: fleet, deliveryFleetRequestedAt: new Date(), deliveryFleetRequestNote: note ?? null }).where(eq(locations.id, locationId)).returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'location.delivery_fleet.request', entityType: 'location', entityId: locationId, before: { deliveryFleet: loc.deliveryFleet }, after: { requested: fleet, note } });
    return row;
  }

  async cancelDeliveryFleetRequest(user: JwtPayload, locationId: string) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const [row] = await this.db.update(locations).set({ deliveryFleetRequested: null, deliveryFleetRequestedAt: null, deliveryFleetRequestNote: null }).where(eq(locations.id, locationId)).returning();
    return row;
  }

  async listDeliveryFleetRequests(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db
      .select({ id: locations.id, name: locations.name, city: locations.city, organizationId: locations.organizationId, organizationName: organizations.name, deliveryFleet: locations.deliveryFleet, requested: locations.deliveryFleetRequested, requestedAt: locations.deliveryFleetRequestedAt, note: locations.deliveryFleetRequestNote })
      .from(locations)
      .innerJoin(organizations, eq(organizations.id, locations.organizationId))
      .where(isNotNull(locations.deliveryFleetRequested));
  }

  async reviewDeliveryFleet(user: JwtPayload, locationId: string, approve: boolean, note?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Platform staff only');
    const loc = await this.requireLocation(locationId);
    if (!loc.deliveryFleetRequested) throw new BadRequestException('No pending delivery option request');
    const [row] = await this.db
      .update(locations)
      .set({ ...(approve ? { deliveryFleet: loc.deliveryFleetRequested } : {}), deliveryFleetRequested: null, deliveryFleetRequestedAt: null, deliveryFleetRequestNote: null })
      .where(eq(locations.id, locationId))
      .returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: approve ? 'location.delivery_fleet.approve' : 'location.delivery_fleet.decline', entityType: 'location', entityId: locationId, before: { deliveryFleet: loc.deliveryFleet }, after: { deliveryFleet: row.deliveryFleet, note } });
    return row;
  }

  /** Mark a location as a Made at Gutad food hall (Gutad's culinary team prepares its brands). */
  async setPlatformOperated(user: JwtPayload, locationId: string, value: boolean) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Platform staff only');
    const loc = await this.requireLocation(locationId);
    const [row] = await this.db.update(locations).set({ platformOperated: value }).where(eq(locations.id, locationId)).returning();
    await this.redis.del(`loc:${loc.slug}`);
    await this.redis.del(`loc:${loc.id}`);
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: value ? 'location.platform_operated.on' : 'location.platform_operated.off', entityType: 'location', entityId: locationId, before: { platformOperated: loc.platformOperated }, after: { platformOperated: value } });
    return row;
  }

  async setStatus(user: JwtPayload, locationId: string, status: 'LIVE' | 'PAUSED' | 'SUSPENDED' | 'OFFBOARDED', reason?: string) {
    const loc = await this.requireLocation(locationId);
    if (status === 'SUSPENDED' || status === 'OFFBOARDED') {
      if (!isPlatformStaff(user)) throw new ForbiddenException('Platform staff only');
    } else assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    if (status === 'LIVE' && !loc.verifiedAt) throw new BadRequestException('Location must be verified before going live');
    const [row] = await this.db
      .update(locations)
      .set({ status, isPaused: status !== 'LIVE', pausedReason: status === 'LIVE' ? null : reason ?? status, pausedUntil: null })
      .where(eq(locations.id, locationId))
      .returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: `location.${status.toLowerCase()}`, entityType: 'location', entityId: locationId, after: { reason } });
    return row;
  }

  /** Temporary pause (e.g. kitchen slammed) with optional auto-resume. */
  async pause(user: JwtPayload, locationId: string, minutes: number | null, reason?: string) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId);
    const [row] = await this.db
      .update(locations)
      .set({ isPaused: true, pausedReason: reason ?? 'Paused by merchant', pausedUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null })
      .where(eq(locations.id, locationId))
      .returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'location.pause', entityType: 'location', entityId: locationId, after: { minutes, reason }, reason });
    return row;
  }

  async resume(user: JwtPayload, locationId: string) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId);
    const [row] = await this.db.update(locations).set({ isPaused: false, pausedReason: null, pausedUntil: null }).where(eq(locations.id, locationId)).returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'location.resume', entityType: 'location', entityId: locationId, before: { pausedReason: loc.pausedReason } });
    return row;
  }

  async setHours(user: JwtPayload, locationId: string, hours: { dayOfWeek: number; opens: string; closes: string; service?: string }[]) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    await this.db.transaction(async (tx) => {
      await tx.delete(openingHours).where(eq(openingHours.locationId, locationId));
      if (hours.length) await tx.insert(openingHours).values(hours.map((h) => ({ ...h, locationId, service: h.service || 'ALL' })));
    });
    return this.db.select().from(openingHours).where(eq(openingHours.locationId, locationId));
  }

  async requireLocation(locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  // ───── publishing & distribution (03) ─────

  async listPublications(user: JwtPayload, locationId: string) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId);
    const rows = await this.db.select().from(publications).where(eq(publications.locationId, locationId));
    const web = loadConfig().PUBLIC_WEB_URL;
    return rows.map((p) => ({ ...p, url: this.publicUrl(p, loc.slug, web) }));
  }

  private publicUrl(p: typeof publications.$inferSelect, locSlug: string, web: string) {
    switch (p.kind) {
      case 'LISTING':
        return `${web}/r/${locSlug}`;
      case 'ORDER_LINK':
      case 'BRANDED_SITE':
        return `${web}/order/${locSlug}?src=${p.slug}`;
      case 'QR':
        return `${web}/order/${locSlug}?src=${p.slug}&ch=QR`;
      case 'BOOKING_WIDGET':
        return `${web}/embed/book/${locSlug}?src=${p.slug}`;
      case 'PARTNER_LINK':
        return p.partnerUrl || '';
      default:
        return `${web}/r/${locSlug}`;
    }
  }

  async createPublication(user: JwtPayload, locationId: string, input: { kind: string; channel: 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR' | 'PARTNER'; config?: Record<string, unknown>; partnerName?: string; partnerUrl?: string }) {
    const loc = await this.requireLocation(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    if (input.kind === 'BRANDED_SITE') await this.entitlements.assertLocation(locationId, 'branded_site');
    if (input.kind === 'BOOKING_WIDGET') await this.entitlements.assertLocation(locationId, 'booking_widget');
    const [row] = await this.db
      .insert(publications)
      .values({ locationId, kind: input.kind, channel: input.channel, slug: `${input.kind.toLowerCase()}-${loc.slug}-${shortCode(4).toLowerCase()}`, config: input.config || {}, partnerName: input.partnerName ?? null, partnerUrl: input.partnerUrl ?? null })
      .returning();
    return { ...row, url: this.publicUrl(row, loc.slug, loadConfig().PUBLIC_WEB_URL) };
  }

  async togglePublication(user: JwtPayload, id: string, isActive: boolean) {
    const [p] = await this.db.select().from(publications).where(eq(publications.id, id)).limit(1);
    if (!p) throw new NotFoundException();
    const loc = await this.requireLocation(p.locationId);
    assertOrgAccess(user, loc.organizationId, loc.id, MANAGER_ROLES);
    const [row] = await this.db.update(publications).set({ isActive }).where(eq(publications.id, id)).returning();
    return row;
  }

  /** Resolve an entry slug (`?src=`) to its channel so origin is tracked from entry through billing. */
  async resolveSource(src: string) {
    const [p] = await this.db.select().from(publications).where(and(eq(publications.slug, src), eq(publications.isActive, true))).limit(1);
    return p ? { publicationId: p.id, channel: p.channel, kind: p.kind } : null;
  }

  /** Delivery-referral-only flow: record the click and (later) partner-reported conversion. */
  async recordReferralClick(publicationId: string) {
    const [p] = await this.db.select().from(publications).where(eq(publications.id, publicationId)).limit(1);
    if (!p || p.kind !== 'PARTNER_LINK') throw new NotFoundException('Partner link not found');
    const referralCode = token(8);
    const [row] = await this.db.insert(referralEvents).values({ publicationId, referralCode }).returning();
    const url = new URL(p.partnerUrl || 'https://example.com');
    url.searchParams.set('ref', referralCode);
    return { referralCode, redirectUrl: url.toString(), partnerName: p.partnerName, eventId: row.id };
  }

  async recordReferralConversion(referralCode: string, partnerOrderId: string, payableCents: number, agreementRef?: string) {
    const [row] = await this.db
      .update(referralEvents)
      .set({ partnerOrderId, convertedAt: new Date(), payableCents, agreementRef: agreementRef ?? null })
      .where(eq(referralEvents.referralCode, referralCode))
      .returning();
    if (!row) throw new NotFoundException('Referral not found');
    return row;
  }
}
