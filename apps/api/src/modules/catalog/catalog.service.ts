import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { brands, itemModifierGroups, locations, menuCategories, menuItems, menus, modifierGroups, modifierOptions } from '../../db/schema';
import { assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { localParts } from '../../common/utils';
import { ApprovalsService } from '../security/approvals.service';

type Channel = (typeof menus.channels.enumValues)[number];

/** Operator/program channels are always allowed; `menu.channels` only restricts consumer-facing entry points. */
const ALWAYS_ALLOWED: Channel[] = ['PHONE', 'WALK_IN', 'CORPORATE', 'CAMPUS', 'API'];
const channelAllowed = (m: { channels: Channel[] }, channel: Channel) => ALWAYS_ALLOWED.includes(channel) || m.channels.includes(channel);

export interface ResolvedItem {
  id: string;
  name: string;
  priceCents: number;
  soldOut: boolean;
  brandId: string | null;
  stationCode: string | null;
  allergens: string[];
  recipeId: string | null;
  modifierGroups: { id: string; name: string; minSelect: number; maxSelect: number; required: boolean; options: { id: string; name: string; priceCents: number; soldOut: boolean }[] }[];
}

@Injectable()
export class CatalogService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly redis: RedisService, private readonly approvals: ApprovalsService) {}

  onModuleInit() {
    this.approvals.register('PRICE_CHANGE', {
      execute: async (req) => {
        const p = req.payload as { itemId: string; priceCents: number; locationId: string };
        const [item] = await this.db.update(menuItems).set({ priceCents: p.priceCents }).where(eq(menuItems.id, p.itemId)).returning();
        await this.audit.log({ organizationId: req.organizationId, actorId: req.decidedById, action: 'menu_item.price', entityType: 'menu_item', entityId: p.itemId, after: { priceCents: p.priceCents }, reason: req.reason });
        await this.invalidate(p.locationId);
        return item;
      },
      canDecide: (user, req) => !!req.organizationId && !!user.orgs?.[req.organizationId]?.roles.includes('MERCHANT_OWNER'),
    });
  }

  /** Public menu for a location on a channel, honoring schedules, channel overrides and sold-outs. */
  async publicMenus(locationId: string, channel: Channel = 'MARKETPLACE', at = new Date()) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    const lp = localParts(at, loc.timezone);
    const menuRows = await this.db.select().from(menus).where(and(eq(menus.locationId, locationId), eq(menus.isActive, true)));
    const visible = menuRows.filter(
      (m) =>
        channelAllowed(m, channel) &&
        m.daysOfWeek.includes(lp.dayOfWeek) &&
        (!m.availableFrom || lp.hhmm >= m.availableFrom) &&
        (!m.availableUntil || lp.hhmm < m.availableUntil),
    );
    const out = [];
    for (const m of visible) out.push(await this.buildMenu(m, channel));
    return out;
  }

  async buildMenu(m: typeof menus.$inferSelect, channel: Channel) {
    const cats = await this.db.select().from(menuCategories).where(eq(menuCategories.menuId, m.id)).orderBy(menuCategories.sortOrder);
    const catIds = cats.map((c) => c.id);
    const items = catIds.length ? await this.db.select().from(menuItems).where(and(inArray(menuItems.categoryId, catIds), eq(menuItems.isActive, true))).orderBy(menuItems.sortOrder) : [];
    const groupsByItem = await this.modifierGroupsFor(items.map((i) => i.id));
    const brand = m.brandId ? (await this.db.select().from(brands).where(eq(brands.id, m.brandId)).limit(1))[0] : null;
    return {
      id: m.id,
      name: m.name,
      locationId: m.locationId,
      brand: brand ? { id: brand.id, slug: brand.slug, name: brand.name, description: brand.description, logoUrl: brand.logoUrl } : null,
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        items: items
          .filter((i) => i.categoryId === c.id)
          .map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            priceCents: this.channelPrice(i, channel),
            imageUrl: i.imageUrl,
            allergens: i.allergens,
            dietaryTags: i.dietaryTags,
            soldOut: i.soldOut && (!i.soldOutUntil || i.soldOutUntil > new Date()),
            modifierGroups: groupsByItem.get(i.id) || [],
          })),
      })),
    };
  }

  channelPrice(i: typeof menuItems.$inferSelect, channel: Channel): number {
    const o = (i.channelPrices as Record<string, number>) || {};
    return typeof o[channel] === 'number' ? o[channel] : i.priceCents;
  }

  async modifierGroupsFor(itemIds: string[]) {
    const map = new Map<string, ResolvedItem['modifierGroups']>();
    if (!itemIds.length) return map;
    const links = await this.db.select().from(itemModifierGroups).where(inArray(itemModifierGroups.itemId, itemIds)).orderBy(itemModifierGroups.sortOrder);
    const gIds = Array.from(new Set(links.map((l) => l.groupId)));
    if (!gIds.length) return map;
    const groups = await this.db.select().from(modifierGroups).where(inArray(modifierGroups.id, gIds));
    const options = await this.db.select().from(modifierOptions).where(inArray(modifierOptions.groupId, gIds));
    for (const l of links) {
      const g = groups.find((x) => x.id === l.groupId);
      if (!g) continue;
      const arr = map.get(l.itemId) || [];
      arr.push({ id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, required: g.required, options: options.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, name: o.name, priceCents: o.priceCents, soldOut: o.soldOut })) });
      map.set(l.itemId, arr);
    }
    return map;
  }

  /** Resolve items for pricing (used by the quote engine). Validates the item belongs to the location & channel. */
  async resolveItems(locationId: string, channel: Channel, itemIds: string[]): Promise<Map<string, ResolvedItem>> {
    const result = new Map<string, ResolvedItem>();
    if (!itemIds.length) return result;
    const rows = await this.db
      .select({ item: menuItems, menu: menus })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .innerJoin(menus, eq(menus.id, menuCategories.menuId))
      .where(and(inArray(menuItems.id, itemIds), eq(menus.locationId, locationId), eq(menus.isActive, true), eq(menuItems.isActive, true)));
    const groups = await this.modifierGroupsFor(rows.map((r) => r.item.id));
    for (const { item, menu } of rows) {
      if (!channelAllowed(menu, channel)) continue;
      result.set(item.id, {
        id: item.id,
        name: item.name,
        priceCents: this.channelPrice(item, channel),
        soldOut: item.soldOut && (!item.soldOutUntil || item.soldOutUntil > new Date()),
        brandId: menu.brandId,
        stationCode: item.stationCode,
        allergens: item.allergens,
        recipeId: item.recipeId,
        modifierGroups: groups.get(item.id) || [],
      });
    }
    return result;
  }

  // ───── merchant management ─────

  private async requireLocationAccess(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    assertOrgAccess(user, loc.organizationId, locationId);
    return loc;
  }

  async listMenus(user: JwtPayload, locationId: string) {
    await this.requireLocationAccess(user, locationId);
    const rows = await this.db.select().from(menus).where(eq(menus.locationId, locationId));
    const out = [];
    for (const m of rows) out.push({ ...m, ...(await this.buildMenu(m, 'DIRECT')) });
    return out;
  }

  async createMenu(user: JwtPayload, locationId: string, input: { name: string; brandId?: string; availableFrom?: string; availableUntil?: string; daysOfWeek?: number[]; channels?: Channel[] }) {
    const loc = await this.requireLocationAccess(user, locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    if (input.brandId) {
      const [b] = await this.db.select().from(brands).where(eq(brands.id, input.brandId)).limit(1);
      if (!b) throw new NotFoundException('Brand not found');
      if (!b.contentRightsOk) throw new BadRequestException('Brand content rights not confirmed; cannot publish');
    }
    const [m] = await this.db.insert(menus).values({ ...input, locationId, organizationId: loc.organizationId }).returning();
    await this.invalidate(locationId);
    return m;
  }

  async updateMenu(user: JwtPayload, menuId: string, input: Partial<{ name: string; isActive: boolean; availableFrom: string | null; availableUntil: string | null; daysOfWeek: number[]; channels: Channel[] }>) {
    const m = await this.requireMenu(user, menuId);
    const [row] = await this.db.update(menus).set({ ...input, version: m.version + 1 }).where(eq(menus.id, menuId)).returning();
    await this.invalidate(m.locationId);
    return row;
  }

  private async requireMenu(user: JwtPayload, menuId: string) {
    const [m] = await this.db.select().from(menus).where(eq(menus.id, menuId)).limit(1);
    if (!m) throw new NotFoundException('Menu not found');
    assertOrgAccess(user, m.organizationId, m.locationId, MANAGER_ROLES);
    return m;
  }

  async addCategory(user: JwtPayload, menuId: string, input: { name: string; sortOrder?: number }) {
    await this.requireMenu(user, menuId);
    const [c] = await this.db.insert(menuCategories).values({ ...input, menuId }).returning();
    return c;
  }

  async addItem(user: JwtPayload, categoryId: string, input: Partial<typeof menuItems.$inferInsert> & { name: string; priceCents: number }) {
    const [cat] = await this.db.select().from(menuCategories).where(eq(menuCategories.id, categoryId)).limit(1);
    if (!cat) throw new NotFoundException('Category not found');
    const m = await this.requireMenu(user, cat.menuId);
    const [item] = await this.db.insert(menuItems).values({ ...input, categoryId }).returning();
    await this.invalidate(m.locationId);
    return item;
  }

  async updateItem(user: JwtPayload, itemId: string, input: Partial<typeof menuItems.$inferInsert>) {
    const found = await this.itemWithMenu(itemId);
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId, MANAGER_ROLES);
    const { id: _i, categoryId: _c, reason, ...safe } = input as typeof input & { reason?: string };
    let approval = null;
    if (safe.priceCents !== undefined && safe.priceCents !== found.item.priceCents) {
      const t = await this.approvals.thresholds();
      const changeBps = found.item.priceCents ? Math.abs(safe.priceCents - found.item.priceCents) * 10000 / found.item.priceCents : 10000;
      const owner = !!user.orgs?.[found.menu.organizationId]?.roles.includes('MERCHANT_OWNER') || user.roles.includes('PLATFORM_ADMIN');
      if (t.priceChangeBps > 0 && changeBps > t.priceChangeBps && !owner) {
        approval = (await this.approvals.submit(user, { kind: 'PRICE_CHANGE', summary: `${found.item.name}: $${(found.item.priceCents / 100).toFixed(2)} → $${(safe.priceCents / 100).toFixed(2)} (${(changeBps / 100).toFixed(1)}%)`, organizationId: found.menu.organizationId, subjectType: 'menu_item', subjectId: itemId, amountCents: safe.priceCents, payload: { itemId, priceCents: safe.priceCents, locationId: found.menu.locationId, previousCents: found.item.priceCents }, reason: reason || 'Menu price update', dedupeKey: `price:${itemId}` })).approval;
        delete safe.priceCents;
      }
    }
    const [item] = Object.keys(safe).length ? await this.db.update(menuItems).set(safe).where(eq(menuItems.id, itemId)).returning() : [found.item];
    await this.audit.log({ organizationId: found.menu.organizationId, actorId: user.sub, action: 'menu_item.update', entityType: 'menu_item', entityId: itemId, before: Object.fromEntries(Object.keys(safe).map((k) => [k, (found.item as Record<string, unknown>)[k]])), after: safe });
    await this.invalidate(found.menu.locationId);
    return approval ? { ...item, approval } : item;
  }

  /** Sold-out controls — any staff member can flip these from the tablet. */
  async setSoldOut(user: JwtPayload, itemId: string, soldOut: boolean, untilMinutes?: number) {
    const found = await this.itemWithMenu(itemId);
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId);
    const [item] = await this.db
      .update(menuItems)
      .set({ soldOut, soldOutUntil: soldOut && untilMinutes ? new Date(Date.now() + untilMinutes * 60_000) : null })
      .where(eq(menuItems.id, itemId))
      .returning();
    await this.invalidate(found.menu.locationId);
    return item;
  }

  async deleteItem(user: JwtPayload, itemId: string) {
    const found = await this.itemWithMenu(itemId);
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId, MANAGER_ROLES);
    await this.db.update(menuItems).set({ isActive: false }).where(eq(menuItems.id, itemId));
    await this.invalidate(found.menu.locationId);
    return { ok: true };
  }

  private async itemWithMenu(itemId: string) {
    const [row] = await this.db
      .select({ item: menuItems, menu: menus })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .innerJoin(menus, eq(menus.id, menuCategories.menuId))
      .where(eq(menuItems.id, itemId))
      .limit(1);
    if (!row) throw new NotFoundException('Item not found');
    return row;
  }

  async createModifierGroup(user: JwtPayload, itemId: string, input: { name: string; minSelect?: number; maxSelect?: number; required?: boolean; options: { name: string; priceCents?: number }[] }) {
    const found = await this.itemWithMenu(itemId);
    assertOrgAccess(user, found.menu.organizationId, found.menu.locationId, MANAGER_ROLES);
    return this.db.transaction(async (tx) => {
      const [g] = await tx.insert(modifierGroups).values({ name: input.name, minSelect: input.minSelect ?? 0, maxSelect: input.maxSelect ?? 1, required: !!input.required }).returning();
      if (input.options.length) await tx.insert(modifierOptions).values(input.options.map((o) => ({ groupId: g.id, name: o.name, priceCents: o.priceCents ?? 0 })));
      await tx.insert(itemModifierGroups).values({ itemId, groupId: g.id });
      await this.invalidate(found.menu.locationId);
      return g;
    });
  }

  async setOptionSoldOut(user: JwtPayload, optionId: string, soldOut: boolean) {
    const [o] = await this.db.select().from(modifierOptions).where(eq(modifierOptions.id, optionId)).limit(1);
    if (!o) throw new NotFoundException();
    const [row] = await this.db.update(modifierOptions).set({ soldOut }).where(eq(modifierOptions.id, optionId)).returning();
    return row;
  }

  /** Bulk import (from POS export or CSV→JSON): creates a menu with categories/items in one transaction. */
  async importMenu(user: JwtPayload, locationId: string, payload: { name: string; brandId?: string; categories: { name: string; items: { name: string; priceCents: number; description?: string; allergens?: string[]; posExternalId?: string; stationCode?: string }[] }[] }) {
    const loc = await this.requireLocationAccess(user, locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const menu = await this.db.transaction(async (tx) => {
      const [m] = await tx.insert(menus).values({ name: payload.name, locationId, organizationId: loc.organizationId, brandId: payload.brandId ?? null }).returning();
      let sort = 0;
      for (const c of payload.categories) {
        const [cat] = await tx.insert(menuCategories).values({ menuId: m.id, name: c.name, sortOrder: sort++ }).returning();
        if (c.items.length) await tx.insert(menuItems).values(c.items.map((i, idx) => ({ ...i, categoryId: cat.id, sortOrder: idx, allergens: i.allergens || [] })));
      }
      await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'menu.import', entityType: 'menu', entityId: m.id, after: { categories: payload.categories.length } }, tx);
      return m;
    });
    await this.invalidate(locationId);
    return menu;
  }

  private async invalidate(locationId: string | null) {
    if (!locationId) return;
    const [loc] = await this.db.select({ slug: locations.slug }).from(locations).where(eq(locations.id, locationId)).limit(1);
    await this.redis.del(`loc:${locationId}`, ...(loc ? [`loc:${loc.slug}`] : []));
  }
}
