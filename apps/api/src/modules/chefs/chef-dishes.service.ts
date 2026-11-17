import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { CHEF_DISH_MATERIAL_FIELDS, chefDishMissing, chefDishTitle, type ChefDishInput, type ChefStarterDish, type PublicChefDish } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { chefDishes, chefProfiles, locations, menuCategories, menuItems, menus } from '../../db/schema';
import { assertCan, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { chefPhotoUrl, ChefFilesService } from './chef-files.service';
import { ChefsService } from './chefs.service';

type Dish = typeof chefDishes.$inferSelect;
type Profile = typeof chefProfiles.$inferSelect;
const HANDLING: Record<string, string[]> = { HOT: ['HOT'], CHILLED_REHEAT: ['COLD'], FROZEN: ['COLD'], ROOM_TEMP: [] };
const PHOTO_PATH = /\/public\/chef-photos\/([0-9a-f-]{36})$/;

/** Chef dish builder, menu sections, Gutad dish review, and the public storefront listing. */
@Injectable()
export class ChefDishesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly chefs: ChefsService, private readonly files: ChefFilesService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  // ───── helpers ─────

  private async invalidate(locationId: string) {
    const [loc] = await this.db.select({ slug: locations.slug }).from(locations).where(eq(locations.id, locationId)).limit(1);
    await this.redis.del(`loc:${locationId}`, ...(loc ? [`loc:${loc.slug}`] : []));
  }

  /** The chef's single menu at their kitchen (created on first use) with a default section. */
  private async ensureMenu(p: Profile) {
    if (!p.locationId) throw new ConflictException('No approved kitchen');
    let [m] = await this.db.select().from(menus).where(and(eq(menus.locationId, p.locationId), eq(menus.organizationId, p.organizationId))).limit(1);
    if (!m) [m] = await this.db.insert(menus).values({ organizationId: p.organizationId, locationId: p.locationId, name: `${p.displayName} menu`, channels: ['MARKETPLACE', 'DIRECT'] }).returning();
    const cats = await this.db.select().from(menuCategories).where(eq(menuCategories.menuId, m.id)).orderBy(asc(menuCategories.sortOrder));
    if (!cats.length) cats.push((await this.db.insert(menuCategories).values({ menuId: m.id, name: 'Dishes', sortOrder: 0 }).returning())[0]);
    return { menu: m, sections: cats };
  }

  /** Photo inputs are chef-photo URLs or file ids; only the chef's own uploads (or existing URLs on this dish) are accepted. */
  private async normalizePhotos(user: JwtPayload, photos: string[] | undefined, existing: string[] = []) {
    if (!photos) return undefined;
    const out: string[] = [];
    for (const raw of photos.slice(0, 8)) {
      if (existing.includes(raw)) { out.push(raw); continue; }
      const id = /^[0-9a-f-]{36}$/.test(raw) ? raw : raw.match(PHOTO_PATH)?.[1];
      if (!id) throw new BadRequestException('Upload dish photos through Gutad');
      await this.files.assertOwnPhoto(user, id);
      out.push(chefPhotoUrl(id)!);
    }
    return out;
  }

  private itemValues(d: Pick<Dish, 'dishName' | 'description' | 'photos' | 'ingredients' | 'portionDesc' | 'prepMinutes' | 'fulfillmentFormat'> & { allergens: string[]; dietaryTags: string[] }) {
    return { name: d.dishName, description: d.description, imageUrl: d.photos[0] || null, photos: d.photos, allergens: d.allergens, dietaryTags: d.dietaryTags, servingSize: d.portionDesc, cookMinutes: d.prepMinutes, handling: HANDLING[d.fulfillmentFormat] || [] };
  }

  private async load(id: string) {
    const [row] = await this.db.select({ d: chefDishes, i: menuItems }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(eq(chefDishes.id, id)).limit(1);
    if (!row) throw new NotFoundException('Dish not found');
    return row;
  }

  private async mine(user: JwtPayload, id: string) {
    const p = await this.chefs.myProfile(user);
    const row = await this.load(id);
    if (row.d.chefProfileId !== p.id) throw new ForbiddenException('Not your dish');
    return { p, ...row };
  }

  private view(d: Dish, i: typeof menuItems.$inferSelect, chefName: string) {
    const merged = { dishName: d.dishName, description: d.description, ingredients: d.ingredients, allergens: i.allergens, dietaryTags: i.dietaryTags, portionDesc: d.portionDesc, mode: d.mode, acceptsSpecialRequests: d.acceptsSpecialRequests, fulfillmentFormat: d.fulfillmentFormat, photos: d.photos, priceCents: i.priceCents, allergensConfirmed: d.allergensConfirmed };
    return {
      ...d,
      title: chefDishTitle(d.dishName, chefName),
      priceCents: i.priceCents,
      allergens: i.allergens,
      dietaryTags: i.dietaryTags,
      sectionId: i.categoryId,
      sortOrder: i.sortOrder,
      soldOut: i.soldOut,
      live: i.isActive,
      missing: chefDishMissing(merged as ChefDishInput),
    };
  }

  // ───── chef: menu & sections ─────

  async myMenu(user: JwtPayload) {
    const p = await this.chefs.myProfile(user);
    const { menu, sections } = await this.ensureMenu(p);
    const rows = await this.db.select({ d: chefDishes, i: menuItems }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(and(eq(chefDishes.chefProfileId, p.id), sql`${chefDishes.reviewStatus} <> 'ARCHIVED'`)).orderBy(asc(menuItems.sortOrder), asc(chefDishes.createdAt));
    const dishes = rows.map((r) => this.view(r.d, r.i, p.displayName));
    return { menuId: menu.id, chefName: p.displayName, sections: sections.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sortOrder, dishes: dishes.filter((d) => d.sectionId === s.id) })) };
  }

  private async mySection(p: Profile, sectionId: string) {
    const { menu } = await this.ensureMenu(p);
    const [c] = await this.db.select().from(menuCategories).where(and(eq(menuCategories.id, sectionId), eq(menuCategories.menuId, menu.id))).limit(1);
    if (!c) throw new BadRequestException('Unknown menu section');
    return c;
  }

  async addSection(user: JwtPayload, name: string) {
    const p = await this.chefs.myProfile(user);
    const { menu, sections } = await this.ensureMenu(p);
    const [c] = await this.db.insert(menuCategories).values({ menuId: menu.id, name: name.trim(), sortOrder: sections.length }).returning();
    return c;
  }

  async renameSection(user: JwtPayload, id: string, name: string) {
    const p = await this.chefs.myProfile(user);
    await this.mySection(p, id);
    const [c] = await this.db.update(menuCategories).set({ name: name.trim() }).where(eq(menuCategories.id, id)).returning();
    return c;
  }

  async deleteSection(user: JwtPayload, id: string) {
    const p = await this.chefs.myProfile(user);
    await this.mySection(p, id);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(menuItems).innerJoin(chefDishes, eq(chefDishes.menuItemId, menuItems.id)).where(and(eq(menuItems.categoryId, id), sql`${chefDishes.reviewStatus} <> 'ARCHIVED'`));
    if (n.n > 0) throw new ConflictException('Move or archive the dishes in this section first');
    const { sections } = await this.ensureMenu(p);
    if (sections.length <= 1) throw new ConflictException('Keep at least one section');
    await this.db.delete(menuCategories).where(eq(menuCategories.id, id));
    return { ok: true };
  }

  /** New order of sections, and of dishes within each section (drag-and-drop or move buttons send the full order). */
  async reorder(user: JwtPayload, input: { sections: { id: string; dishIds: string[] }[] }) {
    const p = await this.chefs.myProfile(user);
    const { sections } = await this.ensureMenu(p);
    const known = new Set(sections.map((s) => s.id));
    if (input.sections.some((s) => !known.has(s.id))) throw new BadRequestException('Unknown menu section');
    const allIds = input.sections.flatMap((s) => s.dishIds);
    const own = allIds.length ? await this.db.select({ id: chefDishes.id, itemId: chefDishes.menuItemId }).from(chefDishes).where(and(inArray(chefDishes.id, allIds), eq(chefDishes.chefProfileId, p.id))) : [];
    if (own.length !== new Set(allIds).size) throw new BadRequestException('Unknown dish');
    const itemOf = new Map(own.map((o) => [o.id, o.itemId]));
    await this.db.transaction(async (tx) => {
      for (const [si, s] of input.sections.entries()) {
        await tx.update(menuCategories).set({ sortOrder: si }).where(eq(menuCategories.id, s.id));
        for (const [di, dishId] of s.dishIds.entries()) await tx.update(menuItems).set({ categoryId: s.id, sortOrder: di }).where(eq(menuItems.id, itemOf.get(dishId)!));
      }
    });
    if (p.locationId) await this.invalidate(p.locationId);
    return this.myMenu(user);
  }

  // ───── chef: dishes ─────

  async create(user: JwtPayload, input: ChefDishInput) {
    const p = await this.chefs.myProfile(user);
    return this.createFor(p, input, user);
  }

  private async createFor(p: Profile, input: ChefDishInput, user?: JwtPayload) {
    const { sections } = await this.ensureMenu(p);
    const section = input.sectionId ? sections.find((s) => s.id === input.sectionId) : sections[0];
    if (!section) throw new BadRequestException('Unknown menu section');
    const photos = user ? (await this.normalizePhotos(user, input.photos)) || [] : input.photos || [];
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(menuItems).where(eq(menuItems.categoryId, section.id));
    const dishName = (input.dishName || 'New dish').trim();
    const [item] = await this.db
      .insert(menuItems)
      .values({ categoryId: section.id, name: dishName, description: input.description || null, priceCents: Math.max(0, input.priceCents || 0), isActive: false, allergens: input.allergens || [], dietaryTags: input.dietaryTags || [], servingSize: input.portionDesc || null, photos, imageUrl: photos[0] || null, cookMinutes: input.prepMinutes ?? 45, handling: HANDLING[input.fulfillmentFormat || 'HOT'], sortOrder: n })
      .returning();
    const [d] = await this.db
      .insert(chefDishes)
      .values({
        menuItemId: item.id,
        chefProfileId: p.id,
        locationId: p.locationId!,
        dishName,
        description: input.description || null,
        cuisine: input.cuisine || null,
        portionDesc: input.portionDesc || '',
        ingredients: input.ingredients || [],
        allergensConfirmed: !!input.allergensConfirmed,
        mode: input.mode || 'FIXED',
        acceptsSpecialRequests: input.mode === 'CUSTOMIZABLE' && !!input.acceptsSpecialRequests,
        fulfillmentFormat: input.fulfillmentFormat || 'HOT',
        prepMinutes: input.prepMinutes ?? 45,
        dailyCapacity: input.dailyCapacity ?? null,
        minLeadDays: input.minLeadDays ?? null,
        cutoffHour: input.cutoffHour ?? null,
        maxAdvanceDays: input.maxAdvanceDays ?? null,
        photos,
      })
      .returning();
    if (user) await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.dish.create', entityType: 'chef_dish', entityId: d.id, after: { dishName } });
    return this.view(d, item, p.displayName);
  }

  /** Starter dishes from an approved application become drafts in the builder. */
  async importStarter(profileId: string, dishes: ChefStarterDish[]) {
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, profileId)).limit(1);
    if (!p) return;
    for (const s of dishes) {
      await this.createFor(p, { dishName: s.name, description: s.description, priceCents: s.priceCents, portionDesc: s.portion, allergens: s.allergens || [], allergensConfirmed: Array.isArray(s.allergens), mode: s.mode || 'FIXED' });
    }
  }

  async get(user: JwtPayload, id: string) {
    const { p, d, i } = await this.mine(user, id);
    return this.view(d, i, p.displayName);
  }

  /**
   * Drafts change directly. On a live dish, operational fields (price, prep time, capacity, lead time, cutoff)
   * apply at once, while material fields (what the customer eats or is told) wait in pendingChanges for review.
   */
  async update(user: JwtPayload, id: string, input: ChefDishInput) {
    const { p, d, i } = await this.mine(user, id);
    if (['ARCHIVED', 'SUSPENDED'].includes(d.reviewStatus)) throw new ConflictException(`This dish is ${d.reviewStatus.toLowerCase()}`);
    if (d.reviewStatus === 'IN_REVIEW') throw new ConflictException({ message: 'This dish is being reviewed; you can edit it again after the decision', code: 'DISH_IN_REVIEW' });
    const photos = await this.normalizePhotos(user, input.photos, d.photos);
    const mode = input.mode ?? (d.mode as 'FIXED' | 'CUSTOMIZABLE');
    const patch: Record<string, unknown> = { ...input, ...(photos ? { photos } : {}) };
    if (mode === 'FIXED') patch.acceptsSpecialRequests = false;
    if (input.dishName !== undefined) patch.dishName = input.dishName.trim();
    const operational = { priceCents: input.priceCents, prepMinutes: input.prepMinutes, dailyCapacity: input.dailyCapacity, minLeadDays: input.minLeadDays, cutoffHour: input.cutoffHour, maxAdvanceDays: input.maxAdvanceDays };
    if (input.sectionId) await this.mySection(p, input.sectionId);
    const live = d.reviewStatus === 'PUBLISHED';
    const material = Object.fromEntries(CHEF_DISH_MATERIAL_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    const changedMaterial = Object.entries(material).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(k === 'allergens' ? i.allergens : k === 'dietaryTags' ? i.dietaryTags : (d as Record<string, unknown>)[k]));
    const dishSet: Partial<typeof chefDishes.$inferInsert> = {};
    const itemSet: Partial<typeof menuItems.$inferInsert> = {};
    for (const k of ['prepMinutes', 'dailyCapacity', 'minLeadDays', 'cutoffHour', 'maxAdvanceDays'] as const) if (operational[k] !== undefined) (dishSet as Record<string, unknown>)[k] = operational[k];
    if (operational.priceCents !== undefined) itemSet.priceCents = Math.max(0, operational.priceCents);
    if (operational.prepMinutes !== undefined) itemSet.cookMinutes = operational.prepMinutes;
    if (input.sectionId && input.sectionId !== i.categoryId) itemSet.categoryId = input.sectionId;
    if (input.cuisine !== undefined) dishSet.cuisine = input.cuisine;
    if (input.allergensConfirmed !== undefined && !live) dishSet.allergensConfirmed = input.allergensConfirmed;
    if (live && changedMaterial.length) {
      dishSet.pendingChanges = { ...((d.pendingChanges as Record<string, unknown>) || {}), ...Object.fromEntries(changedMaterial), ...(input.allergensConfirmed !== undefined ? { allergensConfirmed: input.allergensConfirmed } : {}) };
      dishSet.submittedAt = new Date();
    } else if (!live) {
      for (const [k, v] of Object.entries(material)) {
        if (k === 'allergens') itemSet.allergens = v as string[];
        else if (k === 'dietaryTags') itemSet.dietaryTags = v as string[];
        else (dishSet as Record<string, unknown>)[k] = v;
      }
      const next = { ...d, ...dishSet } as Dish;
      Object.assign(itemSet, { ...this.itemValues({ ...next, allergens: itemSet.allergens ?? i.allergens, dietaryTags: itemSet.dietaryTags ?? i.dietaryTags }), isActive: false });
      if (d.reviewStatus === 'CHANGES_REQUESTED') dishSet.reviewStatus = 'CHANGES_REQUESTED';
    }
    if (Object.keys(dishSet).length) await this.db.update(chefDishes).set(dishSet).where(eq(chefDishes.id, id));
    if (Object.keys(itemSet).length) await this.db.update(menuItems).set(itemSet).where(eq(menuItems.id, i.id));
    if (live) await this.invalidate(d.locationId);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: live && changedMaterial.length ? 'chef.dish.change_requested' : 'chef.dish.update', entityType: 'chef_dish', entityId: id, before: { priceCents: i.priceCents }, after: { ...operational, material: changedMaterial.map(([k]) => k) } });
    const out = await this.get(user, id);
    return { ...out, needsReview: live && changedMaterial.length > 0 };
  }

  async submit(user: JwtPayload, id: string) {
    const { p, d, i } = await this.mine(user, id);
    if (!['DRAFT', 'CHANGES_REQUESTED'].includes(d.reviewStatus)) throw new ConflictException(`A ${d.reviewStatus.toLowerCase()} dish cannot be submitted`);
    const v = this.view(d, i, p.displayName);
    if (v.missing.length) throw new BadRequestException({ message: `Finish the dish first: ${v.missing.join(', ')}`, code: 'DISH_INCOMPLETE', missing: v.missing });
    await this.db.update(chefDishes).set({ reviewStatus: 'IN_REVIEW', submittedAt: new Date(), reviewNote: null }).where(eq(chefDishes.id, id));
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.dish.submit', entityType: 'chef_dish', entityId: id });
    return this.get(user, id);
  }

  async setSoldOut(user: JwtPayload, id: string, soldOut: boolean) {
    const { p, d, i } = await this.mine(user, id);
    await this.db.update(menuItems).set({ soldOut, soldOutSource: soldOut ? 'MANUAL' : null, soldOutUntil: null }).where(eq(menuItems.id, i.id));
    await this.invalidate(d.locationId);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: soldOut ? 'chef.dish.sold_out' : 'chef.dish.back', entityType: 'chef_dish', entityId: id });
    return this.get(user, id);
  }

  async archive(user: JwtPayload, id: string) {
    const { p, d, i } = await this.mine(user, id);
    await this.db.update(chefDishes).set({ reviewStatus: 'ARCHIVED', pendingChanges: null }).where(eq(chefDishes.id, id));
    await this.db.update(menuItems).set({ isActive: false }).where(eq(menuItems.id, i.id));
    await this.invalidate(d.locationId);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.dish.archive', entityType: 'chef_dish', entityId: id });
    return { ok: true };
  }

  // ───── Gutad review ─────

  async reviewQueue(user: JwtPayload) {
    assertCan(user, 'chefs.read');
    const rows = await this.db
      .select({ d: chefDishes, i: menuItems, chef: chefProfiles.displayName, slug: chefProfiles.slug })
      .from(chefDishes)
      .innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId))
      .innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId))
      .where(or(eq(chefDishes.reviewStatus, 'IN_REVIEW'), isNotNull(chefDishes.pendingChanges)))
      .orderBy(asc(chefDishes.submittedAt))
      .limit(200);
    return rows.map((r) => ({ ...this.view(r.d, r.i, r.chef), chefName: r.chef, chefSlug: r.slug, kind: r.d.reviewStatus === 'IN_REVIEW' ? 'NEW_LISTING' : 'CHANGE' }));
  }

  async adminList(user: JwtPayload, q: { status?: string; chefId?: string }) {
    assertCan(user, 'chefs.read');
    const where = [];
    if (q.status) where.push(inArray(chefDishes.reviewStatus, q.status.split(',')));
    if (q.chefId) where.push(eq(chefDishes.chefProfileId, q.chefId));
    const rows = await this.db.select({ d: chefDishes, i: menuItems, chef: chefProfiles.displayName }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId)).where(where.length ? and(...where) : undefined).orderBy(asc(chefProfiles.displayName)).limit(500);
    return rows.map((r) => ({ ...this.view(r.d, r.i, r.chef), chefName: r.chef }));
  }

  /**
   * APPROVE publishes a new listing or applies pending changes; CHANGES sends a listing back (or discards pending
   * changes) with a note; SUSPEND hides a live dish; REINSTATE brings it back.
   */
  async review(user: JwtPayload, id: string, input: { decision: 'APPROVE' | 'CHANGES' | 'SUSPEND' | 'REINSTATE'; note?: string }) {
    assertCan(user, 'chefs.manage');
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const { d, i } = await this.load(id);
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, d.chefProfileId)).limit(1);
    const note = (input.note || '').trim();
    if (input.decision !== 'APPROVE' && note.length < 5) throw new BadRequestException({ message: 'Add a note for the chef', code: 'REASON_REQUIRED' });
    const pending = d.pendingChanges as Record<string, unknown> | null;
    let dishSet: Partial<typeof chefDishes.$inferInsert> = { reviewedById: user.sub, reviewNote: note || null };
    let itemSet: Partial<typeof menuItems.$inferInsert> = {};
    if (input.decision === 'APPROVE') {
      if (d.reviewStatus === 'IN_REVIEW') {
        const v = this.view(d, i, p.displayName);
        if (v.missing.length) throw new BadRequestException({ message: `Incomplete: ${v.missing.join(', ')}`, code: 'DISH_INCOMPLETE' });
        dishSet = { ...dishSet, reviewStatus: 'PUBLISHED', publishedAt: new Date() };
        itemSet = { ...this.itemValues({ ...d, allergens: i.allergens, dietaryTags: i.dietaryTags }), isActive: true };
      } else if (pending) {
        const { allergens, dietaryTags, ...rest } = pending as { allergens?: string[]; dietaryTags?: string[] } & Record<string, unknown>;
        const next = { ...d, ...rest } as Dish;
        dishSet = { ...dishSet, ...(rest as Partial<Dish>), pendingChanges: null };
        itemSet = this.itemValues({ ...next, allergens: allergens ?? i.allergens, dietaryTags: dietaryTags ?? i.dietaryTags });
      } else throw new ConflictException('Nothing to approve');
    } else if (input.decision === 'CHANGES') {
      if (d.reviewStatus === 'IN_REVIEW') { dishSet.reviewStatus = 'CHANGES_REQUESTED'; itemSet.isActive = false; }
      else if (pending) dishSet.pendingChanges = null;
      else throw new ConflictException('Nothing waiting for review');
    } else if (input.decision === 'SUSPEND') {
      dishSet.reviewStatus = 'SUSPENDED';
      itemSet.isActive = false;
    } else {
      if (d.reviewStatus !== 'SUSPENDED') throw new ConflictException('Only suspended dishes can be reinstated');
      dishSet.reviewStatus = 'PUBLISHED';
      itemSet.isActive = true;
    }
    await this.db.update(chefDishes).set(dishSet).where(eq(chefDishes.id, id));
    if (Object.keys(itemSet).length) await this.db.update(menuItems).set(itemSet).where(eq(menuItems.id, i.id));
    await this.invalidate(d.locationId);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: `chef.dish.review.${input.decision.toLowerCase()}`, entityType: 'chef_dish', entityId: id, before: { status: d.reviewStatus, pending: !!pending }, after: dishSet, reason: note || null });
    const after = await this.load(id);
    return this.view(after.d, after.i, p.displayName);
  }

  // ───── public storefront ─────

  private publicDish(d: Dish, i: typeof menuItems.$inferSelect, p: Profile, loc: { id: string; slug: string; name: string }, section: string | null): PublicChefDish {
    const op = (p.operating || {}) as { minLeadDays?: number; maxAdvanceDays?: number; cutoffHour?: number };
    return {
      id: d.id,
      menuItemId: i.id,
      title: chefDishTitle(d.dishName, p.displayName),
      dishName: d.dishName,
      description: d.description,
      priceCents: i.priceCents,
      portionDesc: d.portionDesc,
      ingredients: d.ingredients,
      allergens: i.allergens,
      dietaryTags: i.dietaryTags,
      photos: d.photos,
      mode: d.mode as PublicChefDish['mode'],
      acceptsSpecialRequests: d.acceptsSpecialRequests,
      fulfillmentFormat: d.fulfillmentFormat as PublicChefDish['fulfillmentFormat'],
      soldOut: i.soldOut,
      minLeadDays: d.minLeadDays ?? op.minLeadDays ?? 1,
      maxAdvanceDays: d.maxAdvanceDays ?? op.maxAdvanceDays ?? 30,
      cutoffHour: d.cutoffHour ?? op.cutoffHour ?? 12,
      section,
      chef: { id: p.id, slug: p.slug, displayName: p.displayName, portraitUrl: chefPhotoUrl(p.portraitFileId) },
      location: loc,
    };
  }

  async storefront(slug: string) {
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.slug, slug)).limit(1);
    if (!p || p.status !== 'ACTIVE' || !p.locationId) return [];
    const [loc] = await this.db.select({ id: locations.id, slug: locations.slug, name: locations.name }).from(locations).where(eq(locations.id, p.locationId)).limit(1);
    const rows = await this.db
      .select({ d: chefDishes, i: menuItems, section: menuCategories.name, sectionOrder: menuCategories.sortOrder })
      .from(chefDishes)
      .innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId))
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .where(and(eq(chefDishes.chefProfileId, p.id), eq(chefDishes.reviewStatus, 'PUBLISHED'), eq(menuItems.isActive, true)))
      .orderBy(asc(menuCategories.sortOrder), asc(menuItems.sortOrder));
    return rows.map((r) => this.publicDish(r.d, r.i, p, loc, r.section));
  }

  async publicDishById(id: string) {
    const [r] = await this.db
      .select({ d: chefDishes, i: menuItems, p: chefProfiles, section: menuCategories.name })
      .from(chefDishes)
      .innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId))
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .innerJoin(chefProfiles, eq(chefProfiles.id, chefDishes.chefProfileId))
      .where(eq(chefDishes.id, id))
      .limit(1);
    if (!r || r.d.reviewStatus !== 'PUBLISHED' || !r.i.isActive || r.p.status !== 'ACTIVE') throw new NotFoundException('Dish not available');
    const [loc] = await this.db.select({ id: locations.id, slug: locations.slug, name: locations.name, isPaused: locations.isPaused }).from(locations).where(eq(locations.id, r.d.locationId)).limit(1);
    return { ...this.publicDish(r.d, r.i, r.p, { id: loc.id, slug: loc.slug, name: loc.name }, r.section), acceptingOrders: r.p.acceptingOrders && !loc.isPaused };
  }

  /** Chef display name for a chef kitchen (quote lines, tickets, receipts use the branded title). */
  async chefNameForLocation(locationId: string) {
    const [p] = await this.db.select({ displayName: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.locationId, locationId)).limit(1);
    return p?.displayName ?? null;
  }
}
