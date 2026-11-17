import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  CHEF_REQUEST_OPEN,
  chefDishTitle,
  chefRequestCode,
  DEFAULT_CHEF_REQUEST_POLICY,
  evaluateCustomization,
  modifierLabel,
  type ChefQuoteCartLine,
  type ChefRequestDetail,
  type ChefRequestPolicy,
  type ChefRequestQuote,
  type ChefRequestStatus,
  type ChefRequestSummary,
} from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { chefDishes, chefProfiles, chefRequestMessages, chefRequestQuotes, chefRequests, locations, menuItems, orders, orgMemberships, users } from '../../db/schema';
import { can, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { OutboxService } from '../../core/outbox.service';
import { SettingsService } from '../../core/settings.service';
import { ChefCalendarService } from './chef-calendar.service';
import { ChefOptionsService } from './chef-options.service';

type Req = typeof chefRequests.$inferSelect;
type Quote = typeof chefRequestQuotes.$inferSelect;
type Role = 'CUSTOMER' | 'CHEF' | 'STAFF';

export interface CreateRequestInput {
  dishId: string;
  requestType: 'ADD' | 'REMOVE' | 'SWAP' | 'PORTION' | 'OTHER';
  details: string;
  ingredient?: string | null;
  servings: number;
  requestedDate: string;
  requestedTime?: string | null;
  reason: 'PREFERENCE' | 'ALLERGY' | 'DIETARY' | 'OCCASION';
  budgetCents?: number | null;
  alternativesOk?: boolean;
  alternativesNote?: string | null;
  baseOptionIds?: string[];
}

export interface QuoteInput {
  kind: 'QUOTE' | 'ALTERNATIVE';
  /** ALTERNATIVE only: sell a different dish (the chef's own; Gutad staff may suggest another chef's) */
  altDishId?: string | null;
  optionIds?: string[];
  changes: string;
  portionDesc?: string | null;
  unitPriceCents: number;
  quantity?: number;
  allergens: string[];
  dietaryTags: string[];
  prepMinutes?: number | null;
  serviceDate: string;
  serviceTime?: string | null;
  note?: string | null;
  validHours?: number;
}

const OPEN = CHEF_REQUEST_OPEN as string[];
const hours = (n: number, from = new Date()) => new Date(from.getTime() + n * 3_600_000);

/**
 * Gutad Chef Network special requests: a customer asks for a change the dish's options don't cover; the chef quotes
 * it (versioned), suggests an alternative, asks a question, or declines. An accepted quote becomes a cart line priced
 * from the quote and goes through normal checkout (which re-checks the date and capacity).
 */
@Injectable()
export class ChefRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly calendar: ChefCalendarService,
    private readonly options: ChefOptionsService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  policy() {
    return this.settings.getObject<ChefRequestPolicy>('chefs.requests', DEFAULT_CHEF_REQUEST_POLICY);
  }

  // ───── customer ─────

  async create(user: JwtPayload, input: CreateRequestInput) {
    const [r] = await this.db
      .select({ d: chefDishes, i: menuItems, p: chefProfiles })
      .from(chefDishes)
      .innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId))
      .innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId))
      .where(eq(chefDishes.id, input.dishId))
      .limit(1);
    if (!r || r.d.reviewStatus !== 'PUBLISHED' || !r.i.isActive || r.p.status !== 'ACTIVE') throw new NotFoundException('Dish not available');
    if (!r.d.acceptsSpecialRequests) throw new BadRequestException({ message: `${r.p.displayName} doesn’t take special requests for this dish`, code: 'REQUESTS_CLOSED' });
    if (!r.p.acceptingOrders) throw new BadRequestException({ message: `${r.p.displayName} isn’t taking orders right now`, code: 'CHEF_NOT_ACCEPTING' });
    if (r.p.userId === user.sub) throw new BadRequestException({ message: 'You can’t send a request to your own kitchen', code: 'OWN_KITCHEN' });
    const pol = await this.policy();
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(chefRequests).where(and(eq(chefRequests.userId, user.sub), inArray(chefRequests.status, OPEN)));
    if (n >= pol.maxOpenPerCustomer) throw new BadRequestException({ message: `You have ${n} open requests. Finish or withdraw one first.`, code: 'TOO_MANY_REQUESTS' });
    // the date must be one the chef could still cook this dish for (cutoff, notice, cooking days, advance window)
    const day = await this.dayStatus(r.d.id, input.requestedDate, input.servings);
    if (!day || ['CUTOFF_PASSED', 'TOO_FAR', 'NOT_COOKING', 'PAUSED', 'CLOSED'].includes(day.status)) {
      throw new BadRequestException({ message: day ? `${input.requestedDate} can’t be requested: ${day.status === 'CUTOFF_PASSED' ? 'ordering for that day has closed' : day.status === 'TOO_FAR' ? 'it’s too far ahead' : 'the chef isn’t cooking that day'}` : 'Pick a date the chef is cooking', code: 'REQUEST_DATE_UNAVAILABLE' });
    }
    let baseOptionIds: string[] = [];
    if (input.baseOptionIds?.length) {
      const ev = evaluateCustomization(r.d.dishName, await this.options.groupsForDish(r.d), input.baseOptionIds, { allergens: r.i.allergens, dietaryTags: r.i.dietaryTags || [] });
      if (!ev.ok) throw new BadRequestException({ message: ev.errors[0], code: 'CUSTOMIZATION_INVALID' });
      baseOptionIds = ev.optionIds;
    }
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(chefRequests)
        .values({
          userId: user.sub,
          chefProfileId: r.p.id,
          locationId: r.d.locationId,
          chefDishId: r.d.id,
          requestType: input.requestType,
          details: input.details.trim(),
          ingredient: input.ingredient?.trim() || null,
          servings: input.servings,
          requestedDate: input.requestedDate,
          requestedTime: input.requestedTime || null,
          reason: input.reason,
          budgetCents: input.budgetCents ?? null,
          alternativesOk: input.alternativesOk ?? true,
          alternativesNote: input.alternativesNote?.trim() || null,
          baseOptionIds,
          status: 'PENDING',
          respondBy: hours(pol.chefResponseHours),
        })
        .returning();
      await this.outbox.publish('chef_request.created', row.id, { requestId: row.id, chefProfileId: r.p.id, dishId: r.d.id, userId: user.sub }, tx);
      return row.id;
    });
    await this.notifyParty('CHEF', id, 'chef.request.new');
    return this.detail(user, id);
  }

  async mine(user: JwtPayload) {
    const rows = await this.db.select().from(chefRequests).where(eq(chefRequests.userId, user.sub)).orderBy(desc(chefRequests.lastActivityAt)).limit(100);
    return this.summaries(rows, false);
  }

  /** Accept the current quote: it becomes a cart line priced from the quote (quantity and date fixed). */
  async accept(user: JwtPayload, id: string, quoteId: string) {
    const r = await this.load(id);
    this.assertCustomer(user, r);
    if (r.status !== 'QUOTED' || r.currentQuoteId !== quoteId) throw new ConflictException({ message: 'This quote is no longer current. Refresh the request.', code: 'QUOTE_NOT_CURRENT' });
    const q = await this.quoteRow(quoteId);
    if (q.status !== 'SENT') throw new ConflictException({ message: `This quote is ${q.status.toLowerCase().replace('_', ' ')}`, code: 'QUOTE_NOT_CURRENT' });
    if (q.expiresAt < new Date()) throw new ConflictException({ message: 'This quote has expired. Ask the chef for a new one.', code: 'QUOTE_EXPIRED' });
    await this.db.transaction(async (tx) => {
      await tx.update(chefRequestQuotes).set({ status: 'ACCEPTED', acceptedAt: new Date() }).where(eq(chefRequestQuotes.id, q.id));
      await tx.update(chefRequests).set({ status: 'ACCEPTED', respondBy: null, lastActivityAt: new Date() }).where(eq(chefRequests.id, r.id));
      await this.system(tx, r.id, `Quote v${q.version} accepted. Payable until ${q.expiresAt.toISOString()}.`);
      await this.outbox.publish('chef_request.accepted', r.id, { requestId: r.id, quoteId: q.id, userId: user.sub }, tx);
    });
    await this.notifyParty('CHEF', r.id, 'chef.request.accepted');
    return { request: await this.detail(user, r.id), cartLine: await this.cartLine(q) };
  }

  /** Ask the chef for a new version (also un-accepts an accepted quote that wasn't paid yet). */
  async revise(user: JwtPayload, id: string, note: string) {
    const r = await this.load(id);
    this.assertCustomer(user, r);
    if (!['QUOTED', 'ACCEPTED'].includes(r.status) || !r.currentQuoteId) throw new ConflictException({ message: 'There is no quote to revise', code: 'REQUEST_STATE' });
    const pol = await this.policy();
    await this.db.transaction(async (tx) => {
      await tx.update(chefRequestQuotes).set({ status: 'REVISION_REQUESTED' }).where(eq(chefRequestQuotes.id, r.currentQuoteId!));
      await tx.update(chefRequests).set({ status: 'PENDING', respondBy: hours(pol.chefResponseHours), lastActivityAt: new Date() }).where(eq(chefRequests.id, r.id));
      await tx.insert(chefRequestMessages).values({ requestId: r.id, authorId: user.sub, authorRole: 'CUSTOMER', body: `Revision requested: ${note.trim()}` });
    });
    await this.notifyParty('CHEF', r.id, 'chef.request.revision', { body: note });
    return this.detail(user, r.id);
  }

  async withdraw(user: JwtPayload, id: string, reason?: string) {
    const r = await this.load(id);
    this.assertCustomer(user, r);
    if (!OPEN.includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase()}`, code: 'REQUEST_STATE' });
    await this.db.transaction(async (tx) => {
      if (r.currentQuoteId) await tx.update(chefRequestQuotes).set({ status: 'DECLINED' }).where(and(eq(chefRequestQuotes.id, r.currentQuoteId), inArray(chefRequestQuotes.status, ['SENT', 'ACCEPTED'])));
      await tx.update(chefRequests).set({ status: 'WITHDRAWN', respondBy: null, closedReason: reason?.trim() || 'Withdrawn by the customer', lastActivityAt: new Date() }).where(eq(chefRequests.id, r.id));
      await this.system(tx, r.id, `Withdrawn by the customer${reason ? `: ${reason.trim()}` : ''}`);
    });
    await this.notifyParty('CHEF', r.id, 'chef.request.withdrawn', { reason });
    return this.detail(user, r.id);
  }

  /** A message from any party. A customer reply to the chef's question puts the request back with the chef. */
  async message(user: JwtPayload, id: string, body: string) {
    const r = await this.load(id);
    const role = await this.roleOf(user, r);
    if (!OPEN.includes(r.status) && role !== 'STAFF') throw new ConflictException({ message: `This request is ${r.status.toLowerCase()}`, code: 'REQUEST_STATE' });
    const pol = await this.policy();
    await this.db.transaction(async (tx) => {
      await tx.insert(chefRequestMessages).values({ requestId: r.id, authorId: user.sub, authorRole: role, body: body.trim() });
      const back = role === 'CUSTOMER' && r.status === 'NEEDS_INFO';
      await tx.update(chefRequests).set({ lastActivityAt: new Date(), ...(back ? { status: 'PENDING', respondBy: hours(pol.chefResponseHours) } : {}) }).where(eq(chefRequests.id, r.id));
    });
    if (role === 'CUSTOMER') await this.notifyParty('CHEF', r.id, 'chef.request.message', { body, from: 'the customer' });
    else if (role === 'CHEF') await this.notifyParty('CUSTOMER', r.id, 'chef.request.message', { body });
    else { await this.notifyParty('CUSTOMER', r.id, 'chef.request.message', { body, from: 'Gutad' }); await this.notifyParty('CHEF', r.id, 'chef.request.message', { body, from: 'Gutad' }); }
    return this.detail(user, r.id);
  }

  // ───── chef ─────

  async inbox(user: JwtPayload, status?: string) {
    const p = await this.chefProfileOf(user);
    const rows = await this.db.select().from(chefRequests).where(eq(chefRequests.chefProfileId, p.id)).orderBy(desc(chefRequests.lastActivityAt)).limit(200);
    const bucket = (s: string) => (s === 'PENDING' ? 'needsReply' : s === 'NEEDS_INFO' || s === 'QUOTED' ? 'waiting' : s === 'ACCEPTED' || s === 'ORDERED' ? 'won' : 'closed');
    const counts = { needsReply: 0, waiting: 0, won: 0, closed: 0 };
    for (const r of rows) counts[bucket(r.status) as keyof typeof counts]++;
    const filtered = status ? rows.filter((r) => bucket(r.status) === status || r.status === status) : rows;
    // the chef works the oldest deadline first
    const list = await this.summaries(filtered, true);
    list.sort((a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || (a.status === 'PENDING' && b.status === 'PENDING' ? String(a.respondBy).localeCompare(String(b.respondBy)) : 0));
    return { requests: list, counts };
  }

  /** Accept and quote, or suggest an alternative: a new quote version that supersedes the previous one. */
  async quote(user: JwtPayload, id: string, input: QuoteInput) {
    const r = await this.load(id);
    const role = await this.roleOf(user, r);
    if (role === 'CUSTOMER') throw new ForbiddenException();
    if (role === 'STAFF' && !can(user, 'chefs.manage')) throw new ForbiddenException();
    if (!['PENDING', 'NEEDS_INFO', 'QUOTED'].includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase().replace('_', ' ')}`, code: 'REQUEST_STATE' });
    // the dish sold: the requested one, or (alternative) another published dish
    const dishId = input.kind === 'ALTERNATIVE' && input.altDishId ? input.altDishId : r.chefDishId;
    const [t] = await this.db.select({ d: chefDishes, i: menuItems, p: chefProfiles }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId)).where(eq(chefDishes.id, dishId)).limit(1);
    if (!t || t.d.reviewStatus !== 'PUBLISHED' || !t.i.isActive || t.p.status !== 'ACTIVE') throw new BadRequestException({ message: 'That dish isn’t live', code: 'DISH_NOT_LIVE' });
    if (t.p.id !== r.chefProfileId && role !== 'STAFF') throw new ForbiddenException({ message: 'Suggest one of your own dishes', code: 'NOT_YOUR_DISH' });
    if (input.kind === 'ALTERNATIVE' && t.d.id !== r.chefDishId && !r.alternativesOk) throw new BadRequestException({ message: 'The customer asked for no alternatives', code: 'NO_ALTERNATIVES' });
    const quantity = input.quantity ?? r.servings;
    // option ids: kept from the request when the dish is the same; validated against the dish sold
    const optionIds = input.optionIds ?? (t.d.id === r.chefDishId ? r.baseOptionIds : []);
    let mods: string[] = optionIds;
    const groups = await this.options.groupsForDish(t.d);
    if (groups.length) {
      // fills the dish's defaults, so the quote states the full recipe it prices
      const ev = evaluateCustomization(t.d.dishName, groups, optionIds, { allergens: t.i.allergens, dietaryTags: t.i.dietaryTags || [] });
      if (!ev.ok) throw new BadRequestException({ message: ev.errors[0], code: 'CUSTOMIZATION_INVALID' });
      mods = ev.optionIds;
    }
    // the date must still be orderable at the quoted quantity (the hold happens at checkout)
    const day = await this.dayStatus(t.d.id, input.serviceDate, quantity);
    if (!day || day.status !== 'AVAILABLE') throw new BadRequestException({ message: `${input.serviceDate} isn’t open for ${quantity} × ${t.d.dishName}${day ? ` (${day.status.toLowerCase().replace('_', ' ')})` : ''}. Pick another date or open it in your calendar.`, code: 'QUOTE_DATE_UNAVAILABLE' });
    if (input.serviceTime && !day.slots.includes(input.serviceTime)) throw new BadRequestException({ message: `${input.serviceTime} isn’t one of the times for ${input.serviceDate}`, code: 'QUOTE_TIME_UNAVAILABLE' });
    const pol = await this.policy();
    // valid for the chosen hours, but never past the date's order cutoff
    let expiresAt = hours(Math.min(168, Math.max(1, input.validHours ?? pol.quoteValidHours)));
    if (day.orderBy && new Date(day.orderBy) < expiresAt) expiresAt = new Date(day.orderBy);
    const now = new Date();
    const qid = await this.db.transaction(async (tx) => {
      // serialize versions per request
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chefreq:${r.id}`}))`);
      const [{ v }] = await tx.select({ v: sql<number>`coalesce(max(${chefRequestQuotes.version}), 0)::int` }).from(chefRequestQuotes).where(eq(chefRequestQuotes.requestId, r.id));
      await tx.update(chefRequestQuotes).set({ status: 'SUPERSEDED' }).where(and(eq(chefRequestQuotes.requestId, r.id), eq(chefRequestQuotes.status, 'SENT')));
      const [q] = await tx
        .insert(chefRequestQuotes)
        .values({
          requestId: r.id,
          version: v + 1,
          kind: input.kind,
          chefDishId: t.d.id,
          locationId: t.d.locationId,
          menuItemId: t.d.menuItemId,
          optionIds: mods,
          changes: input.changes.trim(),
          portionDesc: input.portionDesc?.trim() || t.d.portionDesc,
          unitPriceCents: input.unitPriceCents,
          quantity,
          allergens: [...new Set(input.allergens)],
          dietaryTags: [...new Set(input.dietaryTags)],
          prepMinutes: input.prepMinutes ?? null,
          serviceDate: input.serviceDate,
          serviceTime: input.serviceTime || null,
          note: input.note?.trim() || null,
          expiresAt,
          createdById: user.sub,
        })
        .returning();
      await tx.update(chefRequests).set({ status: 'QUOTED', currentQuoteId: q.id, respondBy: null, lastActivityAt: now, firstResponseAt: r.firstResponseAt ?? now }).where(eq(chefRequests.id, r.id));
      await this.outbox.publish('chef_request.quoted', r.id, { requestId: r.id, quoteId: q.id, version: q.version, kind: q.kind, totalCents: q.unitPriceCents * q.quantity }, tx);
      return q.id;
    });
    await this.audit.log({ actorId: user.sub, action: 'chef.request.quote', entityType: 'chef_request', entityId: r.id, after: { quoteId: qid, kind: input.kind, unitPriceCents: input.unitPriceCents, quantity, serviceDate: input.serviceDate } });
    await this.notifyParty('CUSTOMER', r.id, 'chef.request.quoted');
    return this.detail(user, r.id);
  }

  async ask(user: JwtPayload, id: string, body: string) {
    const r = await this.load(id);
    const role = await this.roleOf(user, r);
    if (role !== 'CHEF') throw new ForbiddenException();
    if (!['PENDING', 'QUOTED'].includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase().replace('_', ' ')}`, code: 'REQUEST_STATE' });
    const pol = await this.policy();
    const now = new Date();
    await this.db.transaction(async (tx) => {
      // a question replaces an outstanding quote (the chef will send a new version after the answer)
      if (r.currentQuoteId && r.status === 'QUOTED') await tx.update(chefRequestQuotes).set({ status: 'SUPERSEDED' }).where(and(eq(chefRequestQuotes.id, r.currentQuoteId), eq(chefRequestQuotes.status, 'SENT')));
      await tx.insert(chefRequestMessages).values({ requestId: r.id, authorId: user.sub, authorRole: 'CHEF', body: body.trim() });
      await tx.update(chefRequests).set({ status: 'NEEDS_INFO', respondBy: hours(pol.customerReplyHours), lastActivityAt: now, firstResponseAt: r.firstResponseAt ?? now }).where(eq(chefRequests.id, r.id));
    });
    await this.notifyParty('CUSTOMER', r.id, 'chef.request.question', { body });
    return this.detail(user, r.id);
  }

  async decline(user: JwtPayload, id: string, reason: string) {
    const r = await this.load(id);
    const role = await this.roleOf(user, r);
    if (role !== 'CHEF') throw new ForbiddenException();
    if (!['PENDING', 'NEEDS_INFO', 'QUOTED'].includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase().replace('_', ' ')}`, code: 'REQUEST_STATE' });
    const now = new Date();
    await this.db.transaction(async (tx) => {
      if (r.currentQuoteId) await tx.update(chefRequestQuotes).set({ status: 'SUPERSEDED' }).where(and(eq(chefRequestQuotes.id, r.currentQuoteId), eq(chefRequestQuotes.status, 'SENT')));
      await tx.insert(chefRequestMessages).values({ requestId: r.id, authorId: user.sub, authorRole: 'CHEF', body: `Declined: ${reason.trim()}` });
      await tx.update(chefRequests).set({ status: 'DECLINED', respondBy: null, closedReason: reason.trim(), lastActivityAt: now, firstResponseAt: r.firstResponseAt ?? now }).where(eq(chefRequests.id, r.id));
      await this.outbox.publish('chef_request.declined', r.id, { requestId: r.id, reason }, tx);
    });
    await this.notifyParty('CUSTOMER', r.id, 'chef.request.declined', { reason });
    return this.detail(user, r.id);
  }

  // ───── Gutad staff supervision ─────

  async adminList(user: JwtPayload, f: { status?: string; chefId?: string; overdue?: boolean }) {
    if (!isPlatformStaff(user) || !can(user, 'chefs.read')) throw new ForbiddenException();
    const conds = [];
    if (f.status === 'OPEN') conds.push(inArray(chefRequests.status, OPEN));
    else if (f.status) conds.push(eq(chefRequests.status, f.status));
    if (f.chefId) conds.push(eq(chefRequests.chefProfileId, f.chefId));
    if (f.overdue) conds.push(inArray(chefRequests.status, ['PENDING', 'NEEDS_INFO']), sql`${chefRequests.respondBy} < now() + interval '4 hours'`);
    const rows = await this.db.select().from(chefRequests).where(conds.length ? and(...conds) : undefined).orderBy(desc(chefRequests.lastActivityAt)).limit(200);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [stats] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${chefRequests.status} in ('PENDING','NEEDS_INFO','QUOTED','ACCEPTED'))::int`,
        waitingOnChef: sql<number>`count(*) filter (where ${chefRequests.status} = 'PENDING')::int`,
        dueSoon: sql<number>`count(*) filter (where ${chefRequests.status} = 'PENDING' and ${chefRequests.respondBy} < now() + interval '4 hours')::int`,
        total30: sql<number>`count(*) filter (where ${chefRequests.createdAt} >= ${since.toISOString()})::int`,
        avgResponseMinutes: sql<number | null>`round(avg(extract(epoch from (${chefRequests.firstResponseAt} - ${chefRequests.createdAt})) / 60) filter (where ${chefRequests.firstResponseAt} is not null and ${chefRequests.createdAt} >= ${since.toISOString()}))::int`,
        quoted30: sql<number>`count(*) filter (where ${chefRequests.currentQuoteId} is not null and ${chefRequests.createdAt} >= ${since.toISOString()})::int`,
        ordered30: sql<number>`count(*) filter (where ${chefRequests.status} = 'ORDERED' and ${chefRequests.createdAt} >= ${since.toISOString()})::int`,
        expired30: sql<number>`count(*) filter (where ${chefRequests.status} = 'EXPIRED' and ${chefRequests.createdAt} >= ${since.toISOString()})::int`,
      })
      .from(chefRequests);
    return { requests: await this.summaries(rows, true), stats: { ...stats, quoteAcceptancePct: stats.quoted30 ? Math.round((stats.ordered30 * 100) / stats.quoted30) : null } };
  }

  /** Give the party who must act more time (the chef or customer deadline, or the quote's validity). */
  async extend(user: JwtPayload, id: string, addHours: number) {
    if (!isPlatformStaff(user) || !can(user, 'chefs.manage')) throw new ForbiddenException();
    const r = await this.load(id);
    if (!OPEN.includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase()}`, code: 'REQUEST_STATE' });
    await this.db.transaction(async (tx) => {
      if (['PENDING', 'NEEDS_INFO'].includes(r.status)) await tx.update(chefRequests).set({ respondBy: hours(addHours, r.respondBy && r.respondBy > new Date() ? r.respondBy : new Date()) }).where(eq(chefRequests.id, r.id));
      else if (r.currentQuoteId) {
        const q = await this.quoteRow(r.currentQuoteId, tx);
        await tx.update(chefRequestQuotes).set({ expiresAt: hours(addHours, q.expiresAt > new Date() ? q.expiresAt : new Date()) }).where(eq(chefRequestQuotes.id, q.id));
      }
      await this.system(tx, r.id, `Gutad extended the deadline by ${addHours} hours`);
    });
    await this.audit.log({ actorId: user.sub, action: 'chef.request.extend', entityType: 'chef_request', entityId: r.id, after: { addHours } });
    return this.detail(user, r.id);
  }

  async close(user: JwtPayload, id: string, reason: string) {
    if (!isPlatformStaff(user) || !can(user, 'chefs.manage')) throw new ForbiddenException();
    const r = await this.load(id);
    if (!OPEN.includes(r.status)) throw new ConflictException({ message: `This request is ${r.status.toLowerCase()}`, code: 'REQUEST_STATE' });
    await this.db.transaction(async (tx) => {
      if (r.currentQuoteId) await tx.update(chefRequestQuotes).set({ status: 'DECLINED' }).where(and(eq(chefRequestQuotes.id, r.currentQuoteId), inArray(chefRequestQuotes.status, ['SENT', 'ACCEPTED'])));
      await tx.update(chefRequests).set({ status: 'CLOSED', respondBy: null, closedReason: reason.trim(), lastActivityAt: new Date() }).where(eq(chefRequests.id, r.id));
      await tx.insert(chefRequestMessages).values({ requestId: r.id, authorId: user.sub, authorRole: 'STAFF', body: `Closed by Gutad: ${reason.trim()}` });
    });
    await this.audit.log({ actorId: user.sub, action: 'chef.request.close', entityType: 'chef_request', entityId: r.id, after: { reason } });
    await this.notifyParty('CUSTOMER', r.id, 'chef.request.closed', { reason });
    await this.notifyParty('CHEF', r.id, 'chef.request.closed', { reason });
    return this.detail(user, r.id);
  }

  // ───── jobs ─────

  /** Expire requests the chef didn't answer, questions the customer didn't answer, and quotes not accepted or paid in time. */
  async expireDue(now = new Date()) {
    const late = await this.db.select().from(chefRequests).where(and(inArray(chefRequests.status, ['PENDING', 'NEEDS_INFO']), lt(chefRequests.respondBy, now)));
    const quoted = await this.db
      .select({ r: chefRequests, q: chefRequestQuotes })
      .from(chefRequests)
      .innerJoin(chefRequestQuotes, eq(chefRequestQuotes.id, chefRequests.currentQuoteId))
      .where(and(inArray(chefRequests.status, ['QUOTED', 'ACCEPTED']), inArray(chefRequestQuotes.status, ['SENT', 'ACCEPTED']), lt(chefRequestQuotes.expiresAt, now)));
    const expired: { id: string; why: string }[] = [];
    for (const r of late) {
      const why = r.status === 'PENDING' ? 'The chef didn’t answer in time' : 'No reply to the chef’s question in time';
      const ok = await this.db.transaction(async (tx) => {
        const u = await tx.update(chefRequests).set({ status: 'EXPIRED', respondBy: null, closedReason: why, lastActivityAt: now }).where(and(eq(chefRequests.id, r.id), eq(chefRequests.status, r.status))).returning({ id: chefRequests.id });
        if (!u.length) return false;
        await this.system(tx, r.id, why);
        await this.outbox.publish('chef_request.expired', r.id, { requestId: r.id, reason: why }, tx);
        return true;
      });
      if (ok) expired.push({ id: r.id, why });
    }
    for (const { r, q } of quoted) {
      const why = q.status === 'ACCEPTED' ? 'The accepted quote wasn’t paid before it expired' : 'The quote wasn’t accepted before it expired';
      const ok = await this.db.transaction(async (tx) => {
        const u = await tx.update(chefRequests).set({ status: 'EXPIRED', closedReason: why, lastActivityAt: now }).where(and(eq(chefRequests.id, r.id), inArray(chefRequests.status, ['QUOTED', 'ACCEPTED']))).returning({ id: chefRequests.id });
        if (!u.length) return false;
        await tx.update(chefRequestQuotes).set({ status: 'EXPIRED' }).where(eq(chefRequestQuotes.id, q.id));
        await this.system(tx, r.id, why);
        await this.outbox.publish('chef_request.expired', r.id, { requestId: r.id, reason: why }, tx);
        return true;
      });
      if (ok) expired.push({ id: r.id, why });
    }
    for (const e of expired) {
      await this.notifyParty('CUSTOMER', e.id, 'chef.request.expired', { reason: e.why }).catch(() => undefined);
      await this.notifyParty('CHEF', e.id, 'chef.request.expired', { reason: e.why }).catch(() => undefined);
    }
    return { expired: expired.length };
  }

  // ───── reading ─────

  async detail(user: JwtPayload, id: string): Promise<ChefRequestDetail & { cartLine: ChefQuoteCartLine | null }> {
    const r = await this.load(id);
    const role = await this.roleOf(user, r);
    const [sum] = await this.summaries([r], role !== 'CUSTOMER');
    const qs = await this.db.select().from(chefRequestQuotes).where(eq(chefRequestQuotes.requestId, r.id)).orderBy(desc(chefRequestQuotes.version));
    const quotes = await this.presentQuotes(qs);
    const msgs = await this.db.select({ m: chefRequestMessages, name: users.name }).from(chefRequestMessages).leftJoin(users, eq(users.id, chefRequestMessages.authorId)).where(eq(chefRequestMessages.requestId, r.id)).orderBy(asc(chefRequestMessages.createdAt));
    const [d] = await this.db.select({ d: chefDishes, i: menuItems }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(eq(chefDishes.id, r.chefDishId)).limit(1);
    const baseOptionNames = r.baseOptionIds.length && d ? evaluateCustomization(d.d.dishName, await this.options.groupsForDish(d.d), r.baseOptionIds, { allergens: d.i.allergens, dietaryTags: d.i.dietaryTags || [] }).chosen.map(modifierLabel) : [];
    const chefName = await this.chefDisplayName(r.chefProfileId);
    const current = qs.find((q) => q.id === r.currentQuoteId);
    const open = OPEN.includes(r.status);
    const manage = role === 'STAFF' && can(user, 'chefs.manage');
    return {
      ...sum,
      baseOptionIds: r.baseOptionIds,
      baseOptionNames,
      alternativesNote: r.alternativesNote,
      quotes,
      messages: msgs.map(({ m, name }) => ({ id: m.id, authorRole: m.authorRole as 'CUSTOMER', authorName: m.authorRole === 'CHEF' ? chefName : m.authorRole === 'STAFF' ? 'Gutad' : m.authorRole === 'SYSTEM' ? null : role === 'CUSTOMER' ? 'You' : name, body: m.body, createdAt: m.createdAt.toISOString() })),
      can: {
        quote: (role === 'CHEF' || manage) && ['PENDING', 'NEEDS_INFO', 'QUOTED'].includes(r.status),
        ask: role === 'CHEF' && ['PENDING', 'QUOTED'].includes(r.status),
        decline: role === 'CHEF' && ['PENDING', 'NEEDS_INFO', 'QUOTED'].includes(r.status),
        accept: role === 'CUSTOMER' && r.status === 'QUOTED' && !!current && current.status === 'SENT' && current.expiresAt > new Date(),
        revise: role === 'CUSTOMER' && ['QUOTED', 'ACCEPTED'].includes(r.status),
        withdraw: role === 'CUSTOMER' && open,
        message: open || role === 'STAFF',
        close: manage && open,
      },
      viewerRole: role,
      cartLine: role === 'CUSTOMER' && r.status === 'ACCEPTED' && current && current.status === 'ACCEPTED' && current.expiresAt > new Date() ? await this.cartLine(current) : null,
    };
  }

  private async summaries(rows: Req[], withCustomer: boolean): Promise<ChefRequestSummary[]> {
    if (!rows.length) return [];
    const dishIds = [...new Set(rows.map((r) => r.chefDishId))];
    const dishes = new Map((await this.db.select({ d: chefDishes, i: menuItems, p: chefProfiles }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId)).where(inArray(chefDishes.id, dishIds))).map((x) => [x.d.id, x]));
    const quoteIds = rows.map((r) => r.currentQuoteId).filter((x): x is string => !!x);
    const quotes = new Map((await this.presentQuotes(quoteIds.length ? await this.db.select().from(chefRequestQuotes).where(inArray(chefRequestQuotes.id, quoteIds)) : [])).map((q) => [q.id, q]));
    const names = withCustomer ? new Map((await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.userId))]))).map((u) => [u.id, u.name])) : new Map<string, string | null>();
    return rows.map((r) => {
      const x = dishes.get(r.chefDishId)!;
      return {
        id: r.id,
        code: chefRequestCode(r.id),
        status: r.status as ChefRequestStatus,
        requestType: r.requestType as ChefRequestSummary['requestType'],
        details: r.details,
        ingredient: r.ingredient,
        servings: r.servings,
        requestedDate: r.requestedDate,
        requestedTime: r.requestedTime,
        reason: r.reason as ChefRequestSummary['reason'],
        budgetCents: r.budgetCents,
        alternativesOk: r.alternativesOk,
        respondBy: r.respondBy?.toISOString() ?? null,
        orderId: r.orderId,
        dish: { id: x.d.id, menuItemId: x.d.menuItemId, title: chefDishTitle(x.d.dishName, x.p.displayName), dishName: x.d.dishName, photo: x.d.photos[0] ?? null, priceCents: x.i.priceCents },
        chef: { id: x.p.id, slug: x.p.slug, displayName: x.p.displayName },
        ...(withCustomer ? { customer: { name: firstName(names.get(r.userId) ?? null) } } : {}),
        latestQuote: r.currentQuoteId ? quotes.get(r.currentQuoteId) ?? null : null,
        lastActivityAt: r.lastActivityAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  private async presentQuotes(qs: Quote[]): Promise<ChefRequestQuote[]> {
    if (!qs.length) return [];
    const ds = new Map((await this.db.select({ d: chefDishes, p: chefProfiles, l: { id: locations.id, slug: locations.slug, name: locations.name } }).from(chefDishes).innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId)).innerJoin(locations, eq(locations.id, chefDishes.locationId)).where(inArray(chefDishes.id, [...new Set(qs.map((q) => q.chefDishId))]))).map((x) => [x.d.id, x]));
    return qs.map((q) => {
      const x = ds.get(q.chefDishId)!;
      return {
        id: q.id,
        version: q.version,
        kind: q.kind as ChefRequestQuote['kind'],
        status: q.status as ChefRequestQuote['status'],
        changes: q.changes,
        portionDesc: q.portionDesc,
        unitPriceCents: q.unitPriceCents,
        quantity: q.quantity,
        totalCents: q.unitPriceCents * q.quantity,
        allergens: q.allergens,
        dietaryTags: q.dietaryTags,
        prepMinutes: q.prepMinutes,
        serviceDate: q.serviceDate,
        serviceTime: q.serviceTime,
        note: q.note,
        expiresAt: q.expiresAt.toISOString(),
        acceptedAt: q.acceptedAt?.toISOString() ?? null,
        dish: { id: x.d.id, menuItemId: x.d.menuItemId, title: chefDishTitle(x.d.dishName, x.p.displayName), dishName: x.d.dishName, photo: x.d.photos[0] ?? null },
        chef: { id: x.p.id, slug: x.p.slug, displayName: x.p.displayName },
        location: x.l,
        createdAt: q.createdAt.toISOString(),
      };
    });
  }

  private async cartLine(q: Quote): Promise<ChefQuoteCartLine> {
    const [x] = await this.presentQuotes([q]);
    const [d] = await this.db.select({ d: chefDishes, i: menuItems }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(eq(chefDishes.id, q.chefDishId)).limit(1);
    const names = q.optionIds.length ? evaluateCustomization(d.d.dishName, await this.options.groupsForDish(d.d), q.optionIds, { allergens: d.i.allergens, dietaryTags: d.i.dietaryTags || [] }).chosen.map(modifierLabel) : [];
    return { chefRequestQuoteId: q.id, menuItemId: q.menuItemId, name: `${x.dish.title} · special request`, quantity: q.quantity, unitPriceCents: q.unitPriceCents, modifierOptionIds: q.optionIds, modifierNames: [q.changes, ...names], serviceDate: q.serviceDate, serviceTime: q.serviceTime, location: x.location, chefName: x.chef.displayName };
  }

  // ───── helpers ─────

  private async dayStatus(dishId: string, date: string, quantity: number) {
    const a = await this.calendar.dishAvailability(dishId, { from: date, to: date, quantity });
    return a.days.find((d) => d.date === date) ?? null;
  }

  private async load(id: string, tx: DbOrTx = this.db) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Request not found');
    const [r] = await tx.select().from(chefRequests).where(eq(chefRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  private async quoteRow(id: string, tx: DbOrTx = this.db) {
    const [q] = await tx.select().from(chefRequestQuotes).where(eq(chefRequestQuotes.id, id)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    return q;
  }

  private assertCustomer(user: JwtPayload, r: Req) {
    if (r.userId !== user.sub) throw new NotFoundException('Request not found');
  }

  /** The viewer's side of a request: the customer, a member of the chef's kitchen, or Gutad staff. */
  private async roleOf(user: JwtPayload, r: Req): Promise<Role> {
    if (r.userId === user.sub) return 'CUSTOMER';
    const [m] = await this.db.select({ id: chefProfiles.id }).from(chefProfiles).innerJoin(orgMemberships, and(eq(orgMemberships.organizationId, chefProfiles.organizationId), eq(orgMemberships.userId, user.sub))).where(eq(chefProfiles.id, r.chefProfileId)).limit(1);
    if (m) return 'CHEF';
    if (isPlatformStaff(user) && can(user, 'chefs.read')) return 'STAFF';
    throw new NotFoundException('Request not found');
  }

  private async chefProfileOf(user: JwtPayload) {
    const [p] = await this.db.select({ p: chefProfiles }).from(chefProfiles).innerJoin(orgMemberships, and(eq(orgMemberships.organizationId, chefProfiles.organizationId), eq(orgMemberships.userId, user.sub))).limit(1);
    if (!p) throw new NotFoundException({ message: 'You are not an approved Gutad chef yet', code: 'NOT_A_CHEF' });
    return p.p;
  }

  private async chefDisplayName(chefProfileId: string) {
    const [p] = await this.db.select({ n: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.id, chefProfileId)).limit(1);
    return p?.n ?? 'The chef';
  }

  private system(tx: DbOrTx, requestId: string, body: string) {
    return tx.insert(chefRequestMessages).values({ requestId, authorRole: 'SYSTEM', body });
  }

  /** Notify the customer, or the chef (the kitchen owner), with the request's current state. */
  private async notifyParty(to: 'CUSTOMER' | 'CHEF', requestId: string, template: string, extra: Record<string, unknown> = {}) {
    const r = await this.load(requestId);
    const [p] = await this.db.select({ userId: chefProfiles.userId, name: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.id, r.chefProfileId)).limit(1);
    const [d] = await this.db.select({ n: chefDishes.dishName }).from(chefDishes).where(eq(chefDishes.id, r.chefDishId)).limit(1);
    const [tz] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, r.locationId)).limit(1);
    const q = r.currentQuoteId ? await this.quoteRow(r.currentQuoteId) : null;
    const userId = to === 'CUSTOMER' ? r.userId : p?.userId;
    if (!userId) return;
    await this.notify.queue({
      userId,
      template,
      payload: { requestId: r.id, code: chefRequestCode(r.id), audience: to === 'CHEF' ? 'chef' : 'customer', chefName: p?.name, dishTitle: d ? chefDishTitle(d.n, p?.name || 'Chef') : '', requestedDate: r.requestedDate, respondBy: r.respondBy, totalCents: q ? q.unitPriceCents * q.quantity : undefined, serviceDate: q?.serviceDate, quoteExpiresAt: q?.expiresAt, version: q?.version, kind: q?.kind, timezone: tz?.tz, ...extra },
      dedupeKey: `${template}:${r.id}:${r.lastActivityAt.getTime()}:${to}`,
    });
  }
}

function firstName(n: string | null) {
  return n ? n.trim().split(/\s+/)[0] : null;
}

/** Used by quote and checkout: the accepted chef quote behind a cart line (Gutad Chef Network special requests). */
export async function acceptedChefQuote(tx: DbOrTx, quoteId: string) {
  const [x] = await tx.select({ q: chefRequestQuotes, r: chefRequests }).from(chefRequestQuotes).innerJoin(chefRequests, eq(chefRequests.id, chefRequestQuotes.requestId)).where(eq(chefRequestQuotes.id, quoteId)).limit(1);
  return x ?? null;
}

/** Checkout placed an order from accepted chef quotes: mark them ordered (once; a second use is a conflict). */
export async function markChefQuotesOrdered(tx: DbOrTx, quoteIds: string[], orderId: string) {
  for (const id of quoteIds) {
    const u = await tx.update(chefRequestQuotes).set({ status: 'ORDERED', orderId }).where(and(eq(chefRequestQuotes.id, id), eq(chefRequestQuotes.status, 'ACCEPTED'))).returning({ requestId: chefRequestQuotes.requestId, version: chefRequestQuotes.version });
    if (!u.length) throw new ConflictException({ message: 'A special-request quote in this cart was already used or is no longer valid', code: 'CHEF_QUOTE_USED' });
    const [o] = await tx.select({ number: orders.number }).from(orders).where(eq(orders.id, orderId)).limit(1);
    await tx.update(chefRequests).set({ status: 'ORDERED', orderId, lastActivityAt: new Date() }).where(eq(chefRequests.id, u[0].requestId));
    await tx.insert(chefRequestMessages).values({ requestId: u[0].requestId, authorRole: 'SYSTEM', body: `Paid: order ${o?.number ?? ''} placed from quote v${u[0].version}` });
  }
}

