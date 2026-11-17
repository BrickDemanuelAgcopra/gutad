import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { chefProfiles, legalSellers, locations, organizations, orgMemberships } from '../../db/schema';
import { assertCan, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { chefPhotoUrl, ChefFilesService } from './chef-files.service';

type Profile = typeof chefProfiles.$inferSelect;

/** Chef self-service (profile, availability switch, payouts) and the public chef directory. */
@Injectable()
export class ChefsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly files: ChefFilesService, private readonly payments: PaymentsService, private readonly audit: AuditService) {}

  publicProfile(p: Profile) {
    return {
      id: p.id,
      slug: p.slug,
      displayName: p.displayName,
      bio: p.bio,
      portraitUrl: chefPhotoUrl(p.portraitFileId),
      portfolio: p.portfolioFileIds.map((f) => chefPhotoUrl(f)),
      cuisines: p.cuisines,
      languages: p.languages,
      experienceYears: p.experienceYears,
      serviceCity: p.serviceCity,
      serviceRegion: p.serviceRegion,
      verifiedCredentials: p.verifiedCredentials,
      acceptingOrders: p.acceptingOrders && p.status === 'ACTIVE',
      operating: p.operating,
      locationId: p.locationId,
    };
  }

  /** The chef profile of the signed-in chef (checked against the database, so a fresh approval works before re-login). */
  async myProfile(user: JwtPayload) {
    const rows = await this.db
      .select({ p: chefProfiles })
      .from(chefProfiles)
      .innerJoin(orgMemberships, and(eq(orgMemberships.organizationId, chefProfiles.organizationId), eq(orgMemberships.userId, user.sub)))
      .limit(1);
    if (!rows.length) throw new NotFoundException({ message: 'You are not an approved Gutad chef yet', code: 'NOT_A_CHEF' });
    return rows[0].p;
  }

  async me(user: JwtPayload) {
    const p = await this.myProfile(user);
    const [loc] = p.locationId ? await this.db.select().from(locations).where(eq(locations.id, p.locationId)).limit(1) : [];
    const [seller] = loc?.legalSellerId ? await this.db.select().from(legalSellers).where(eq(legalSellers.id, loc.legalSellerId)).limit(1) : [];
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, p.organizationId)).limit(1);
    const checklist = [
      { key: 'approved', label: 'Application approved', done: true },
      { key: 'payouts', label: 'Payouts connected', done: seller?.payoutOnboardingState === 'COMPLETE' },
      { key: 'portrait', label: 'Portrait photo', done: !!p.portraitFileId },
      { key: 'open', label: 'Availability opened', done: p.acceptingOrders },
    ];
    return {
      profile: { ...p, portraitUrl: chefPhotoUrl(p.portraitFileId), portfolio: p.portfolioFileIds.map((f) => ({ id: f, url: chefPhotoUrl(f) })) },
      organization: org ? { id: org.id, name: org.name, status: org.status } : null,
      location: loc ? { id: loc.id, name: loc.name, slug: loc.slug, addressLine1: loc.addressLine1, city: loc.city, region: loc.region, postalCode: loc.postalCode, isPaused: loc.isPaused, pausedReason: loc.pausedReason, status: loc.status, acceptsPickup: loc.acceptsPickup, acceptsDelivery: loc.acceptsDelivery, timezone: loc.timezone } : null,
      payouts: seller ? { legalSellerId: seller.id, state: seller.payoutOnboardingState, provider: seller.payoutProvider, bankLast4: seller.bankLast4 } : null,
      checklist,
    };
  }

  async updateProfile(user: JwtPayload, input: { bio?: string; cuisines?: string[]; languages?: string[]; experienceYears?: number | null; portraitFileId?: string | null; portfolioFileIds?: string[]; serviceRadiusKm?: number }) {
    const p = await this.myProfile(user);
    if (input.portraitFileId) await this.files.assertOwnPhoto(user, input.portraitFileId);
    for (const f of input.portfolioFileIds || []) await this.files.assertOwnPhoto(user, f);
    const [row] = await this.db.update(chefProfiles).set(input).where(eq(chefProfiles.id, p.id)).returning();
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.profile.update', entityType: 'chef_profile', entityId: p.id, before: { bio: p.bio, cuisines: p.cuisines }, after: input });
    return row;
  }

  /** Chef switch: dishes appear (and the kitchen opens) only while on. Needs payouts connected and an active, unsuspended profile. */
  async setAccepting(user: JwtPayload, accepting: boolean) {
    const p = await this.myProfile(user);
    if (p.status !== 'ACTIVE') throw new ForbiddenException({ message: p.status === 'SUSPENDED' ? `Your chef account is suspended: ${p.statusReason || 'contact Gutad support'}` : 'Your chef account is paused', code: 'CHEF_NOT_ACTIVE' });
    if (!p.locationId) throw new ConflictException('No approved kitchen');
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, p.locationId)).limit(1);
    if (accepting) {
      const [seller] = loc?.legalSellerId ? await this.db.select().from(legalSellers).where(eq(legalSellers.id, loc.legalSellerId)).limit(1) : [];
      if (seller?.payoutOnboardingState !== 'COMPLETE') throw new BadRequestException({ message: 'Connect payouts before opening availability', code: 'PAYOUTS_REQUIRED' });
    }
    await this.db.update(chefProfiles).set({ acceptingOrders: accepting }).where(eq(chefProfiles.id, p.id));
    await this.db
      .update(locations)
      .set(accepting ? { status: 'LIVE', isPaused: false, pausedReason: null } : { isPaused: true, pausedReason: 'The chef paused availability' })
      .where(eq(locations.id, p.locationId));
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: accepting ? 'chef.availability.open' : 'chef.availability.pause', entityType: 'chef_profile', entityId: p.id });
    return this.me(user);
  }

  /** Hosted payment-provider onboarding (Stripe Express): Gutad never collects bank or identity documents itself. */
  async connectPayouts(user: JwtPayload) {
    const p = await this.myProfile(user);
    const [loc] = p.locationId ? await this.db.select().from(locations).where(eq(locations.id, p.locationId)).limit(1) : [];
    if (!loc?.legalSellerId) throw new ConflictException('No payout entity');
    const asMember: JwtPayload = { ...user, orgs: { ...(user.orgs || {}), [p.organizationId]: { roles: ['MERCHANT_OWNER'], locationIds: [] } } };
    return this.payments.onboardLegalSeller(asMember, loc.legalSellerId, { returnPath: '/chef' });
  }

  // ───── public directory ─────

  async directory(q: { city?: string; region?: string; cuisine?: string; q?: string }) {
    const where = [eq(chefProfiles.status, 'ACTIVE'), eq(chefProfiles.acceptingOrders, true)];
    if (q.region) where.push(eq(chefProfiles.serviceRegion, q.region.toUpperCase()));
    if (q.city) where.push(sql`lower(${chefProfiles.serviceCity}) = ${q.city.toLowerCase()}`);
    if (q.cuisine) where.push(sql`${q.cuisine} = any(${chefProfiles.cuisines})`);
    if (q.q) where.push(sql`(${chefProfiles.displayName} ilike ${'%' + q.q + '%'} or ${chefProfiles.bio} ilike ${'%' + q.q + '%'})`);
    const rows = await this.db.select().from(chefProfiles).where(and(...where)).orderBy(asc(chefProfiles.displayName)).limit(200);
    return rows.map((p) => this.publicProfile(p));
  }

  async bySlug(slug: string) {
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.slug, slug)).limit(1);
    if (!p || p.status === 'SUSPENDED') throw new NotFoundException('Chef not found');
    return this.publicProfile(p);
  }

  // ───── admin: chef profiles ─────

  async adminList(user: JwtPayload, q: { status?: string }) {
    assertCan(user, 'chefs.read');
    const rows = await this.db.select().from(chefProfiles).where(q.status ? inArray(chefProfiles.status, q.status.split(',')) : undefined).orderBy(asc(chefProfiles.displayName)).limit(500);
    return rows.map((p) => ({ ...this.publicProfile(p), status: p.status, statusReason: p.statusReason, organizationId: p.organizationId, legalName: p.legalName, kitchenType: p.kitchenType, createdAt: p.createdAt }));
  }

  async adminSetStatus(user: JwtPayload, id: string, status: 'ACTIVE' | 'PAUSED' | 'SUSPENDED', reason: string) {
    assertCan(user, 'chefs.manage');
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    if ((reason || '').trim().length < 5) throw new BadRequestException({ message: 'A reason is required', code: 'REASON_REQUIRED' });
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, id)).limit(1);
    if (!p) throw new NotFoundException();
    await this.db.update(chefProfiles).set({ status, statusReason: reason, ...(status !== 'ACTIVE' ? { acceptingOrders: false } : {}) }).where(eq(chefProfiles.id, id));
    if (status !== 'ACTIVE' && p.locationId) await this.db.update(locations).set({ isPaused: true, pausedReason: `Chef ${status.toLowerCase()}: ${reason}` }).where(eq(locations.id, p.locationId));
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: `chef.status.${status.toLowerCase()}`, entityType: 'chef_profile', entityId: id, before: { status: p.status }, after: { status }, reason });
    return { ok: true, status };
  }
}
