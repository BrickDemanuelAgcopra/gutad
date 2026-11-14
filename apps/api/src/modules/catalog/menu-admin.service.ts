import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { auditLogs, ingredients, itemLocationOverrides, itemModifierGroups, locations, menuCategories, menuItems, menuLocationLinks, menus, menuVersions, modifierGroups, modifierOptions, priceChanges, recipeLines, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { SettingsService } from '../../core/settings.service';
import { assertOrgAccess, can, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { ApprovalsService } from '../security/approvals.service';

type Item = typeof menuItems.$inferSelect;
/** Fields a menu document carries for each item (modifier groups are managed separately and are not versioned). */
const DOC_FIELDS = ['name', 'description', 'priceCents', 'imageUrl', 'photos', 'allergens', 'dietaryTags', 'isActive', 'sortOrder', 'servingSize', 'kind', 'taxCategory', 'maxPerOrder', 'nutrition', 'channelPrices', 'stationCode', 'cookMinutes', 'handling'] as const;
export interface MenuDoc { categories: { id?: string; name: string; sortOrder?: number; items: (Partial<Pick<Item, (typeof DOC_FIELDS)[number]>> & { id?: string; name: string; priceCents: number })[] }[] }
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('|') : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** 7 — menu versions (draft → review → publish → rollback), shared menus, location overrides, export & validation, allergens; 9.7 price changes. */
@Injectable()
export class MenuAdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly redis: RedisService, private readonly settings: SettingsService, private readonly approvals: ApprovalsService) {}

  private async menu(id: string) {
    const [m] = await this.db.select().from(menus).where(eq(menus.id, id)).limit(1);
    if (!m) throw new NotFoundException('Menu not found');
    return m;
  }

  private async bust(locationIds: (string | null)[]) {
    for (const id of locationIds.filter(Boolean) as string[]) {
      const [l] = await this.db.select({ slug: locations.slug }).from(locations).where(eq(locations.id, id)).limit(1);
      await this.redis.del(`loc:${id}`, ...(l ? [`loc:${l.slug}`] : []));
    }
  }

  private async linkedLocations(menuId: string) {
    return (await this.db.select({ id: menuLocationLinks.locationId }).from(menuLocationLinks).where(eq(menuLocationLinks.menuId, menuId))).map((x) => x.id);
  }

  /** Current live menu as a document. */
  async snapshot(menuId: string): Promise<MenuDoc> {
    const cats = await this.db.select().from(menuCategories).where(eq(menuCategories.menuId, menuId)).orderBy(menuCategories.sortOrder);
    const items = cats.length ? await this.db.select().from(menuItems).where(inArray(menuItems.categoryId, cats.map((c) => c.id))).orderBy(menuItems.sortOrder) : [];
    return { categories: cats.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder, items: items.filter((i) => i.categoryId === c.id).map((i) => ({ id: i.id, ...Object.fromEntries(DOC_FIELDS.map((f) => [f, i[f]])) }) as MenuDoc['categories'][number]['items'][number]) })) };
  }

  // ───── 7.7 versions ─────

  async versions(user: JwtPayload, menuId: string) {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, m.locationId);
    const rows = await this.db.select({ v: menuVersions, author: users.email }).from(menuVersions).leftJoin(users, eq(users.id, menuVersions.createdById)).where(eq(menuVersions.menuId, menuId)).orderBy(desc(menuVersions.version));
    return { menu: { id: m.id, name: m.name, version: m.version }, versions: rows.map((r) => ({ ...r.v, authorEmail: r.author, itemCount: (r.v.document as MenuDoc).categories.reduce((a, c) => a + c.items.length, 0) })) };
  }

  async createDraft(user: JwtPayload, menuId: string, note?: string) {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, m.locationId, MANAGER_ROLES);
    const [open] = await this.db.select().from(menuVersions).where(and(eq(menuVersions.menuId, menuId), inArray(menuVersions.status, ['DRAFT', 'IN_REVIEW']))).limit(1);
    if (open) return open;
    const [max] = await this.db.select({ v: sql<number>`coalesce(max(${menuVersions.version}), 0)::int` }).from(menuVersions).where(eq(menuVersions.menuId, menuId));
    const [row] = await this.db.insert(menuVersions).values({ menuId, version: Math.max(max.v, m.version) + 1, status: 'DRAFT', document: await this.snapshot(menuId), note: note ?? null, createdById: user.sub }).returning();
    return row;
  }

  private async version(id: string) {
    const [v] = await this.db.select().from(menuVersions).where(eq(menuVersions.id, id)).limit(1);
    if (!v) throw new NotFoundException('Version not found');
    return { v, m: await this.menu(v.menuId) };
  }

  validateDoc(doc: MenuDoc) {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!doc?.categories?.length) errors.push('The menu has no categories');
    const names = new Map<string, number>();
    for (const c of doc?.categories || []) {
      if (!c.name?.trim()) errors.push('A category has no name');
      for (const i of c.items || []) {
        if (!i.name?.trim()) errors.push(`An item in ${c.name} has no name`);
        if (!Number.isInteger(i.priceCents) || i.priceCents < 0) errors.push(`${i.name}: price must be a whole number of cents ≥ 0`);
        if (i.priceCents === 0 && i.kind !== 'EXTRA' && i.kind !== 'PACKAGING') warnings.push(`${i.name}: price is $0`);
        const key = (i.name || '').trim().toLowerCase();
        names.set(key, (names.get(key) || 0) + 1);
      }
    }
    const duplicates = [...names.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    for (const d of duplicates) warnings.push(`Duplicate item name: ${d}`);
    return { ok: errors.length === 0, errors, warnings, duplicates };
  }

  async updateDraft(user: JwtPayload, versionId: string, document: MenuDoc, note?: string) {
    const { v, m } = await this.version(versionId);
    assertOrgAccess(user, m.organizationId, m.locationId, MANAGER_ROLES);
    if (v.status !== 'DRAFT') throw new ConflictException('Only drafts can be edited');
    const check = this.validateDoc(document);
    if (!check.ok) throw new BadRequestException({ message: check.errors.join('; '), code: 'MENU_INVALID', ...check });
    const [row] = await this.db.update(menuVersions).set({ document, note: note ?? v.note }).where(eq(menuVersions.id, versionId)).returning();
    return { ...row, validation: check };
  }

  async submit(user: JwtPayload, versionId: string) {
    const { v, m } = await this.version(versionId);
    assertOrgAccess(user, m.organizationId, m.locationId, MANAGER_ROLES);
    if (v.status !== 'DRAFT') throw new ConflictException(`Version is ${v.status}`);
    const [row] = await this.db.update(menuVersions).set({ status: 'IN_REVIEW', submittedAt: new Date() }).where(eq(menuVersions.id, versionId)).returning();
    return row;
  }

  async reject(user: JwtPayload, versionId: string, note: string) {
    const { v, m } = await this.version(versionId);
    this.assertReviewer(user, m, v);
    if (v.status !== 'IN_REVIEW') throw new ConflictException('Only versions in review can be rejected');
    const [row] = await this.db.update(menuVersions).set({ status: 'DRAFT', reviewedById: user.sub, reviewNote: note }).where(eq(menuVersions.id, versionId)).returning();
    return row;
  }

  private assertReviewer(user: JwtPayload, m: typeof menus.$inferSelect, v: typeof menuVersions.$inferSelect) {
    const staff = isPlatformStaff(user) && can(user, 'catalog.manage');
    if (!staff) assertOrgAccess(user, m.organizationId, m.locationId, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    return staff;
  }

  /**
   * Publish a version: the document is applied to the live menu (items matched by id; items left out are switched off,
   * never deleted, so past orders keep their references). With `menus.require_review` on, someone other than the author publishes.
   */
  async publish(user: JwtPayload, versionId: string, note?: string) {
    const { v, m } = await this.version(versionId);
    this.assertReviewer(user, m, v);
    if (!['DRAFT', 'IN_REVIEW'].includes(v.status)) throw new ConflictException(`Version is ${v.status}`);
    const requireReview = await this.settings.get<boolean>('menus.require_review', false);
    if (requireReview && (v.status !== 'IN_REVIEW' || v.createdById === user.sub)) throw new ForbiddenException({ message: 'Menu changes need review by someone other than the author', code: 'REVIEW_REQUIRED' });
    const check = this.validateDoc(v.document as MenuDoc);
    if (!check.ok) throw new BadRequestException({ message: check.errors.join('; '), code: 'MENU_INVALID', ...check });
    await this.ensureBaseline(m, user.sub);
    await this.apply(m, v.document as MenuDoc);
    await this.db.update(menuVersions).set({ status: 'SUPERSEDED' }).where(and(eq(menuVersions.menuId, m.id), eq(menuVersions.status, 'PUBLISHED')));
    const [row] = await this.db.update(menuVersions).set({ status: 'PUBLISHED', publishedAt: new Date(), publishedById: user.sub, reviewedById: user.sub, reviewNote: note ?? v.reviewNote }).where(eq(menuVersions.id, versionId)).returning();
    await this.db.update(menus).set({ version: v.version }).where(eq(menus.id, m.id));
    await this.audit.log({ organizationId: m.organizationId, actorId: user.sub, action: 'menu.publish', entityType: 'menu', entityId: m.id, after: { version: v.version, warnings: check.warnings }, reason: note });
    await this.bust([m.locationId, ...(await this.linkedLocations(m.id))]);
    return row;
  }

  /** The live menu before the first versioned publish becomes version history too, so it can be rolled back to. */
  private async ensureBaseline(m: typeof menus.$inferSelect, userId: string) {
    const [any] = await this.db.select({ id: menuVersions.id }).from(menuVersions).where(and(eq(menuVersions.menuId, m.id), inArray(menuVersions.status, ['PUBLISHED', 'SUPERSEDED']))).limit(1);
    if (any) return;
    await this.db.insert(menuVersions).values({ menuId: m.id, version: m.version, status: 'SUPERSEDED', document: await this.snapshot(m.id), note: 'Live menu before versioning', createdById: userId, publishedAt: new Date() });
  }

  private async apply(m: typeof menus.$inferSelect, doc: MenuDoc) {
    await this.db.transaction(async (tx) => {
      const existingCats = await tx.select().from(menuCategories).where(eq(menuCategories.menuId, m.id));
      const keepItems = new Set<string>();
      let cs = 0;
      for (const c of doc.categories) {
        let catId = c.id && existingCats.some((x) => x.id === c.id) ? c.id : null;
        if (catId) await tx.update(menuCategories).set({ name: c.name, sortOrder: c.sortOrder ?? cs }).where(eq(menuCategories.id, catId));
        else catId = (await tx.insert(menuCategories).values({ menuId: m.id, name: c.name, sortOrder: c.sortOrder ?? cs }).returning())[0].id;
        cs++;
        let is = 0;
        for (const i of c.items) {
          const vals = Object.fromEntries(DOC_FIELDS.filter((f) => (i as Record<string, unknown>)[f] !== undefined).map((f) => [f, (i as Record<string, unknown>)[f]]));
          const [ex] = i.id ? await tx.select({ id: menuItems.id }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).where(and(eq(menuItems.id, i.id), eq(menuCategories.menuId, m.id))).limit(1) : [];
          if (ex) {
            await tx.update(menuItems).set({ ...vals, categoryId: catId, sortOrder: i.sortOrder ?? is, isActive: i.isActive ?? true } as never).where(eq(menuItems.id, ex.id));
            keepItems.add(ex.id);
          } else {
            const [n] = await tx.insert(menuItems).values({ ...vals, name: i.name, priceCents: i.priceCents, categoryId: catId, sortOrder: i.sortOrder ?? is } as never).returning();
            keepItems.add(n.id);
          }
          is++;
        }
      }
      const allCatIds = (await tx.select({ id: menuCategories.id }).from(menuCategories).where(eq(menuCategories.menuId, m.id))).map((x) => x.id);
      if (allCatIds.length) {
        const live = await tx.select({ id: menuItems.id }).from(menuItems).where(inArray(menuItems.categoryId, allCatIds));
        const off = live.map((x) => x.id).filter((id) => !keepItems.has(id));
        if (off.length) await tx.update(menuItems).set({ isActive: false }).where(inArray(menuItems.id, off));
      }
    });
  }

  /** Roll back = publish an older version's document again as a new version. */
  async rollback(user: JwtPayload, versionId: string, reason: string) {
    const { v, m } = await this.version(versionId);
    this.assertReviewer(user, m, v);
    if (!['PUBLISHED', 'SUPERSEDED'].includes(v.status)) throw new ConflictException('Only published versions can be restored');
    await this.db.update(menuVersions).set({ status: 'REJECTED', reviewNote: 'Replaced by a rollback' }).where(and(eq(menuVersions.menuId, m.id), inArray(menuVersions.status, ['DRAFT', 'IN_REVIEW'])));
    const [max] = await this.db.select({ v: sql<number>`coalesce(max(${menuVersions.version}), 0)::int` }).from(menuVersions).where(eq(menuVersions.menuId, m.id));
    const [nv] = await this.db.insert(menuVersions).values({ menuId: m.id, version: max.v + 1, status: 'IN_REVIEW', document: v.document, note: `Rollback to v${v.version}: ${reason}`, createdById: user.sub, submittedAt: new Date() }).returning();
    const requireReview = await this.settings.get<boolean>('menus.require_review', false);
    if (requireReview) await this.db.update(menuVersions).set({ createdById: null }).where(eq(menuVersions.id, nv.id)); // a rollback is an operational action, not a self-authored edit
    return this.publish(user, nv.id, `Rollback to v${v.version}: ${reason}`);
  }

  async diff(user: JwtPayload, versionId: string) {
    const { v, m } = await this.version(versionId);
    assertOrgAccess(user, m.organizationId, m.locationId);
    const live = await this.snapshot(m.id);
    const flat = (d: MenuDoc) => new Map(d.categories.flatMap((c) => c.items.map((i) => [i.id || `new:${c.name}:${i.name}`, { ...i, category: c.name }] as const)));
    const a = flat(live), b = flat(v.document as MenuDoc);
    const added = [...b.entries()].filter(([k]) => !a.has(k)).map(([, i]) => ({ name: i.name, category: i.category, priceCents: i.priceCents }));
    const removed = [...a.entries()].filter(([k, i]) => !b.has(k) && i.isActive !== false).map(([, i]) => ({ name: i.name, category: i.category }));
    const changed = [...b.entries()].filter(([k]) => a.has(k)).map(([k, i]) => {
      const o = a.get(k)!;
      const fields = (['name', 'category', ...DOC_FIELDS] as string[]).filter((f) => f !== 'sortOrder' && JSON.stringify((i as Record<string, unknown>)[f] ?? null) !== JSON.stringify((o as Record<string, unknown>)[f] ?? null) && (i as Record<string, unknown>)[f] !== undefined);
      return { name: i.name, fields: fields.map((f) => ({ field: f, from: (o as Record<string, unknown>)[f] ?? null, to: (i as Record<string, unknown>)[f] ?? null })) };
    }).filter((x) => x.fields.length);
    return { version: v.version, added, removed, changed, validation: this.validateDoc(v.document as MenuDoc) };
  }

  /** Menu version of each item's menu, frozen into the order snapshot (11.8). */
  async menuVersionsFor(itemIds: string[]) {
    if (!itemIds.length) return {};
    const rows = await this.db.select({ menuId: menus.id, version: menus.version }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(inArray(menuItems.id, itemIds));
    return Object.fromEntries(rows.map((r) => [r.menuId, r.version]));
  }

  /** Gutad catalog reviewers: versions waiting for review across merchants. */
  async reviewQueue(user: JwtPayload) {
    if (!can(user, 'catalog.read')) throw new ForbiddenException();
    const rows = await this.db.select({ v: menuVersions, menu: menus.name, orgId: menus.organizationId, locationId: menus.locationId, author: users.email }).from(menuVersions).innerJoin(menus, eq(menus.id, menuVersions.menuId)).leftJoin(users, eq(users.id, menuVersions.createdById)).where(eq(menuVersions.status, 'IN_REVIEW')).orderBy(menuVersions.submittedAt);
    return rows.map((r) => ({ id: r.v.id, menuId: r.v.menuId, menuName: r.menu, organizationId: r.orgId, version: r.v.version, note: r.v.note, authorEmail: r.author, submittedAt: r.v.submittedAt }));
  }

  // ───── 7.8 export & import validation ─────

  async exportMenu(user: JwtPayload, menuId: string, format: 'json' | 'csv') {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, m.locationId);
    const doc = await this.snapshot(menuId);
    if (format === 'json') return JSON.stringify({ name: m.name, brandId: m.brandId, ...doc }, null, 2);
    const head = ['category', 'id', 'name', 'description', 'priceCents', 'kind', 'taxCategory', 'servingSize', 'allergens', 'dietaryTags', 'isActive', 'maxPerOrder', 'imageUrl'];
    return [head.join(','), ...doc.categories.flatMap((c) => c.items.map((i) => head.map((h) => csvCell(h === 'category' ? c.name : (i as Record<string, unknown>)[h])).join(',')))].join('\n');
  }

  async validateImport(user: JwtPayload, locationId: string, payload: MenuDoc & { name?: string }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const check = this.validateDoc(payload);
    const existing = await this.db.select({ name: menuItems.name }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(and(eq(menus.locationId, locationId), eq(menuItems.isActive, true)));
    const have = new Set(existing.map((e) => e.name.trim().toLowerCase()));
    const alreadyOnMenu = payload.categories.flatMap((c) => c.items).filter((i) => have.has((i.name || '').trim().toLowerCase())).map((i) => i.name);
    return { ...check, alreadyOnMenu, items: payload.categories.reduce((a, c) => a + c.items.length, 0) };
  }

  // ───── 7.2 shared modifier groups ─────

  async modifierGroupsForMenu(user: JwtPayload, menuId: string) {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, m.locationId);
    const rows = await this.db.select({ g: modifierGroups, items: sql<number>`count(distinct ${itemModifierGroups.itemId})::int` }).from(modifierGroups).innerJoin(itemModifierGroups, eq(itemModifierGroups.groupId, modifierGroups.id)).innerJoin(menuItems, eq(menuItems.id, itemModifierGroups.itemId)).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).where(eq(menuCategories.menuId, menuId)).groupBy(modifierGroups.id);
    const opts = rows.length ? await this.db.select().from(modifierOptions).where(inArray(modifierOptions.groupId, rows.map((r) => r.g.id))) : [];
    return rows.map((r) => ({ ...r.g, usedBy: r.items, options: opts.filter((o) => o.groupId === r.g.id) }));
  }

  async attachGroup(user: JwtPayload, itemId: string, groupId: string, attach: boolean) {
    const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, itemId)).limit(1);
    if (!found) throw new NotFoundException();
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId, MANAGER_ROLES);
    if (attach) await this.db.insert(itemModifierGroups).values({ itemId, groupId, sortOrder: 99 }).onConflictDoNothing();
    else await this.db.delete(itemModifierGroups).where(and(eq(itemModifierGroups.itemId, itemId), eq(itemModifierGroups.groupId, groupId)));
    await this.bust([found.menu.locationId]);
    return { ok: true };
  }

  // ───── 7.3 allergens derived from the recipe ─────

  async allergens(user: JwtPayload, itemId: string) {
    const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, itemId)).limit(1);
    if (!found) throw new NotFoundException();
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId);
    const derived = await this.derivedAllergens(found.item.recipeId);
    const modIngredients = await this.db.select({ allergens: ingredients.allergens }).from(modifierOptions).innerJoin(itemModifierGroups, eq(itemModifierGroups.groupId, modifierOptions.groupId)).innerJoin(ingredients, eq(ingredients.id, modifierOptions.ingredientId)).where(eq(itemModifierGroups.itemId, itemId));
    const optional = [...new Set(modIngredients.flatMap((x) => x.allergens))];
    const listed = found.item.allergens.map((a) => a.toLowerCase());
    return { listed: found.item.allergens, fromRecipe: derived, fromOptions: optional, missing: derived.filter((a) => !listed.includes(a)), reviewNeeded: found.item.allergenReviewNeeded };
  }

  async derivedAllergens(recipeId: string | null) {
    if (!recipeId) return [];
    const rows = await this.db.select({ allergens: ingredients.allergens }).from(recipeLines).innerJoin(ingredients, eq(ingredients.id, recipeLines.ingredientId)).where(eq(recipeLines.recipeId, recipeId));
    return [...new Set(rows.flatMap((r) => r.allergens.map((a) => a.toLowerCase())))];
  }

  // ───── 7.4 shared menus & location overrides ─────

  async shareMenu(user: JwtPayload, menuId: string, locationIds: string[]) {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, null, MANAGER_ROLES);
    const locs = locationIds.length ? await this.db.select({ id: locations.id, organizationId: locations.organizationId }).from(locations).where(inArray(locations.id, locationIds)) : [];
    if (locs.some((l) => l.organizationId !== m.organizationId)) throw new BadRequestException('Menus can only be shared with your own locations');
    const before = await this.linkedLocations(menuId);
    await this.db.delete(menuLocationLinks).where(eq(menuLocationLinks.menuId, menuId));
    const targets = locationIds.filter((id) => id !== m.locationId);
    if (targets.length) await this.db.insert(menuLocationLinks).values(targets.map((locationId) => ({ menuId, locationId })));
    await this.audit.log({ organizationId: m.organizationId, actorId: user.sub, action: 'menu.share', entityType: 'menu', entityId: menuId, before, after: targets });
    await this.bust([...before, ...targets]);
    return { menuId, locationIds: targets };
  }

  async sharing(user: JwtPayload, menuId: string) {
    const m = await this.menu(menuId);
    assertOrgAccess(user, m.organizationId, m.locationId);
    const linked = await this.linkedLocations(menuId);
    const all = await this.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, m.organizationId));
    const items = await this.db.select({ id: menuItems.id, name: menuItems.name, priceCents: menuItems.priceCents }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).where(and(eq(menuCategories.menuId, menuId), eq(menuItems.isActive, true)));
    const ov = items.length ? await this.db.select().from(itemLocationOverrides).where(inArray(itemLocationOverrides.menuItemId, items.map((i) => i.id))) : [];
    return { ownerLocationId: m.locationId, locations: all.map((l) => ({ ...l, owner: l.id === m.locationId, offered: l.id === m.locationId || linked.includes(l.id) })), items, overrides: ov };
  }

  async setOverride(user: JwtPayload, itemId: string, locationId: string, input: { priceCents?: number | null; hidden?: boolean; soldOut?: boolean }) {
    const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, itemId)).limit(1);
    if (!found) throw new NotFoundException();
    assertOrgAccess(user, found.menu.organizationId, locationId, MANAGER_ROLES);
    const v = { menuItemId: itemId, locationId, priceCents: input.priceCents ?? null, hidden: input.hidden ?? false, soldOut: input.soldOut ?? false };
    const [before] = await this.db.select().from(itemLocationOverrides).where(and(eq(itemLocationOverrides.menuItemId, itemId), eq(itemLocationOverrides.locationId, locationId))).limit(1);
    const [row] = await this.db.insert(itemLocationOverrides).values(v).onConflictDoUpdate({ target: [itemLocationOverrides.menuItemId, itemLocationOverrides.locationId], set: v }).returning();
    await this.audit.log({ organizationId: found.menu.organizationId, actorId: user.sub, action: 'menu_item.location_override', entityType: 'menu_item', entityId: itemId, before: before || null, after: row });
    await this.bust([locationId]);
    return row;
  }

  // ───── 9.7 effective-dated price changes & history ─────

  async schedulePrice(user: JwtPayload, itemId: string, input: { newPriceCents: number; effectiveAt?: string; locationId?: string | null; channel?: string | null; reason?: string }) {
    const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, itemId)).limit(1);
    if (!found) throw new NotFoundException();
    assertOrgAccess(user, found.menu.organizationId, input.locationId || found.menu.locationId, MANAGER_ROLES);
    const prev = input.channel ? ((found.item.channelPrices as Record<string, number>)[input.channel] ?? found.item.priceCents) : found.item.priceCents;
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    const t = await this.approvals.thresholds();
    const changeBps = prev ? (Math.abs(input.newPriceCents - prev) * 10000) / prev : 10000;
    const owner = !!user.orgs?.[found.menu.organizationId]?.roles.includes('MERCHANT_OWNER') || user.roles.includes('PLATFORM_ADMIN');
    const needs = t.priceChangeBps > 0 && changeBps > t.priceChangeBps && !owner;
    const [pc] = await this.db.insert(priceChanges).values({ menuItemId: itemId, locationId: input.locationId ?? null, channel: input.channel ?? null, previousPriceCents: prev, newPriceCents: input.newPriceCents, effectiveAt, status: needs ? 'PENDING_APPROVAL' : 'SCHEDULED', reason: input.reason ?? null, createdById: user.sub }).returning();
    if (needs) {
      const r = await this.approvals.submit(user, { kind: 'PRICE_CHANGE', summary: `${found.item.name}: $${(prev / 100).toFixed(2)} → $${(input.newPriceCents / 100).toFixed(2)} from ${effectiveAt.toISOString().slice(0, 16).replace('T', ' ')}`, organizationId: found.menu.organizationId, subjectType: 'price_change', subjectId: pc.id, amountCents: input.newPriceCents, payload: { priceChangeId: pc.id, itemId, priceCents: input.newPriceCents, locationId: found.menu.locationId }, reason: input.reason || 'Scheduled price change', dedupeKey: `pricechange:${pc.id}` });
      await this.db.update(priceChanges).set({ approvalId: r.approval.id }).where(eq(priceChanges.id, pc.id));
    }
    await this.audit.log({ organizationId: found.menu.organizationId, actorId: user.sub, action: 'price.schedule', entityType: 'menu_item', entityId: itemId, after: pc, reason: input.reason });
    if (!needs && effectiveAt <= new Date()) await this.applyDue();
    return (await this.db.select().from(priceChanges).where(eq(priceChanges.id, pc.id)))[0];
  }

  async cancelPriceChange(user: JwtPayload, id: string) {
    const [pc] = await this.db.select().from(priceChanges).where(eq(priceChanges.id, id)).limit(1);
    if (!pc) throw new NotFoundException();
    const [found] = await this.db.select({ menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, pc.menuItemId)).limit(1);
    assertOrgAccess(user, found.menu.organizationId, null, MANAGER_ROLES);
    if (!['SCHEDULED', 'PENDING_APPROVAL'].includes(pc.status)) throw new ConflictException(`Already ${pc.status.toLowerCase()}`);
    const [row] = await this.db.update(priceChanges).set({ status: 'CANCELED' }).where(eq(priceChanges.id, id)).returning();
    return row;
  }

  /** Called by the PRICE_CHANGE approval handler when the change was scheduled (not immediate). */
  async releaseApproved(priceChangeId: string) {
    await this.db.update(priceChanges).set({ status: 'SCHEDULED' }).where(and(eq(priceChanges.id, priceChangeId), eq(priceChanges.status, 'PENDING_APPROVAL')));
    return this.applyDue();
  }

  /** Worker: apply scheduled price changes that are due. */
  async applyDue() {
    const due = await this.db.select().from(priceChanges).where(and(eq(priceChanges.status, 'SCHEDULED'), lte(priceChanges.effectiveAt, new Date()))).limit(500);
    for (const pc of due) {
      const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, pc.menuItemId)).limit(1);
      if (!found) continue;
      if (pc.locationId && pc.locationId !== found.menu.locationId) {
        await this.db.insert(itemLocationOverrides).values({ menuItemId: pc.menuItemId, locationId: pc.locationId, priceCents: pc.newPriceCents }).onConflictDoUpdate({ target: [itemLocationOverrides.menuItemId, itemLocationOverrides.locationId], set: { priceCents: pc.newPriceCents } });
      } else if (pc.channel) {
        await this.db.update(menuItems).set({ channelPrices: { ...(found.item.channelPrices as Record<string, number>), [pc.channel]: pc.newPriceCents } }).where(eq(menuItems.id, pc.menuItemId));
      } else {
        await this.db.update(menuItems).set({ priceCents: pc.newPriceCents }).where(eq(menuItems.id, pc.menuItemId));
      }
      await this.db.update(priceChanges).set({ status: 'APPLIED', appliedAt: new Date() }).where(eq(priceChanges.id, pc.id));
      await this.audit.log({ organizationId: found.menu.organizationId, actorId: pc.createdById, action: 'menu_item.price', entityType: 'menu_item', entityId: pc.menuItemId, before: { priceCents: pc.previousPriceCents }, after: { priceCents: pc.newPriceCents, channel: pc.channel, locationId: pc.locationId }, reason: pc.reason });
      await this.bust([pc.locationId || found.menu.locationId]);
    }
    return { applied: due.length };
  }

  async priceHistory(user: JwtPayload, itemId: string) {
    const [found] = await this.db.select({ item: menuItems, menu: menus }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.id, itemId)).limit(1);
    if (!found) throw new NotFoundException();
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId);
    const changes = await this.db.select({ pc: priceChanges, email: users.email }).from(priceChanges).leftJoin(users, eq(users.id, priceChanges.createdById)).where(eq(priceChanges.menuItemId, itemId)).orderBy(desc(priceChanges.createdAt));
    const edits = await this.db.select({ a: auditLogs, email: users.email }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(and(eq(auditLogs.entityType, 'menu_item'), eq(auditLogs.entityId, itemId), sql`(${auditLogs.after} ? 'priceCents')`)).orderBy(desc(auditLogs.createdAt)).limit(100);
    return { item: { id: found.item.id, name: found.item.name, priceCents: found.item.priceCents, channelPrices: found.item.channelPrices }, scheduled: changes.map((c) => ({ ...c.pc, createdByEmail: c.email })), history: edits.map((e) => ({ at: e.a.createdAt, by: e.email, action: e.a.action, before: e.a.before, after: e.a.after, reason: e.a.reason })) };
  }
}
