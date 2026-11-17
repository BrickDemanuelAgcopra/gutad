import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { evaluateCustomization, type ModGroup, type OptionsConfigGroup } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { chefDishes, chefDishExtras, chefExtras, chefProfiles, itemModifierGroups, menuItems, modifierGroups, modifierOptions } from '../../db/schema';
import { assertCan, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { ChefsService } from './chefs.service';

type Dish = typeof chefDishes.$inferSelect;
type Extra = typeof chefExtras.$inferSelect;

/**
 * Turns a chef's approved option configuration into real modifier groups on the dish (ids preserved, so saved
 * carts keep working), keeps each dish's extras group in sync with the approved extras catalog, and serves the
 * customer-facing option tree.
 */
@Injectable()
export class ChefOptionsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly chefs: ChefsService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  private async invalidate(locationId: string) {
    await this.redis.del(`loc:${locationId}`);
  }

  // ───── materialization ─────

  /** Replace the dish's generated groups with the configuration (upsert by id) and re-sync extras. */
  async materialize(dish: Dish, config: OptionsConfigGroup[], tx: DbOrTx = this.db) {
    const groups = dish.mode === 'CUSTOMIZABLE' ? config : [];
    const keepGroupIds = new Set(groups.map((g) => g.id));
    const oldGroupIds = dish.modifierGroupIds || [];
    const [extrasGroup] = oldGroupIds.length ? await tx.select({ id: modifierGroups.id }).from(modifierGroups).where(and(inArray(modifierGroups.id, oldGroupIds), eq(modifierGroups.isExtras, true))).limit(1) : [];
    for (const [gi, g] of groups.entries()) {
      const gv = { name: g.name.trim(), minSelect: g.minSelect, maxSelect: g.maxSelect, required: g.required, selectionType: g.selectionType, parentOptionId: g.parentOptionId || null, description: g.description || null, templateKey: g.templateKey || null, isExtras: false };
      await tx.insert(modifierGroups).values({ id: g.id, ...gv }).onConflictDoUpdate({ target: modifierGroups.id, set: gv });
      const keepOpt = g.options.map((o) => o.id);
      await tx.delete(modifierOptions).where(keepOpt.length ? and(eq(modifierOptions.groupId, g.id), sql`${modifierOptions.id} not in (${sql.join(keepOpt.map((x) => sql`${x}::uuid`), sql`, `)})`) : eq(modifierOptions.groupId, g.id));
      for (const [oi, o] of g.options.entries()) {
        const ov = { groupId: g.id, name: o.name.trim(), priceCents: o.priceCents || 0, soldOut: !!o.soldOut, isDefault: !!o.isDefault, maxQty: o.maxQty ?? 1, portionDesc: o.portionDesc || null, prepMinutesDelta: o.prepMinutesDelta || 0, addsAllergens: o.addsAllergens || [], removesDietaryTags: o.removesDietaryTags || [], locked: !!o.locked || g.selectionType === 'INCLUDED', rules: o.rules || {}, description: o.description || null, searchTerms: o.searchTerms || [], sortOrder: oi };
        await tx.insert(modifierOptions).values({ id: o.id, ...ov }).onConflictDoUpdate({ target: modifierOptions.id, set: ov });
      }
      await tx.insert(itemModifierGroups).values({ itemId: dish.menuItemId, groupId: g.id, sortOrder: gi }).onConflictDoUpdate({ target: [itemModifierGroups.itemId, itemModifierGroups.groupId], set: { sortOrder: gi } });
    }
    const drop = oldGroupIds.filter((id) => !keepGroupIds.has(id) && id !== extrasGroup?.id);
    if (drop.length) {
      await tx.delete(itemModifierGroups).where(and(eq(itemModifierGroups.itemId, dish.menuItemId), inArray(itemModifierGroups.groupId, drop)));
      await tx.delete(modifierGroups).where(inArray(modifierGroups.id, drop));
    }
    const ids = [...groups.map((g) => g.id), ...(extrasGroup ? [extrasGroup.id] : [])];
    await tx.update(chefDishes).set({ modifierGroupIds: ids }).where(eq(chefDishes.id, dish.id));
    await this.syncExtrasForDish({ ...dish, mode: dish.mode, modifierGroupIds: ids }, tx);
  }

  /** The dish's extras group holds the approved, allowed extras as QUANTITY options (one option per extra, ids kept). */
  async syncExtrasForDish(dish: Dish, tx: DbOrTx = this.db) {
    const extras = dish.mode === 'CUSTOMIZABLE' && dish.reviewStatus === 'PUBLISHED'
      ? (await tx.select().from(chefExtras).where(and(eq(chefExtras.chefProfileId, dish.chefProfileId), eq(chefExtras.status, 'APPROVED'), eq(chefExtras.active, true)))).filter((e) => e.allDishes || e.dishIds.includes(dish.id))
      : [];
    const ids = dish.modifierGroupIds || [];
    let [group] = ids.length ? await tx.select().from(modifierGroups).where(and(inArray(modifierGroups.id, ids), eq(modifierGroups.isExtras, true))).limit(1) : [];
    if (!extras.length) {
      if (group) {
        await tx.delete(itemModifierGroups).where(and(eq(itemModifierGroups.itemId, dish.menuItemId), eq(itemModifierGroups.groupId, group.id)));
        await tx.delete(modifierGroups).where(eq(modifierGroups.id, group.id));
        await tx.update(chefDishes).set({ modifierGroupIds: ids.filter((x) => x !== group!.id) }).where(eq(chefDishes.id, dish.id));
      }
      await tx.delete(chefDishExtras).where(eq(chefDishExtras.dishId, dish.id));
      return;
    }
    if (!group) {
      [group] = await tx.insert(modifierGroups).values({ name: 'Add extras', minSelect: 0, maxSelect: 20, required: false, selectionType: 'QUANTITY', isExtras: true, description: 'Approved extras from the chef' }).returning();
      await tx.insert(itemModifierGroups).values({ itemId: dish.menuItemId, groupId: group.id, sortOrder: 999 }).onConflictDoNothing();
      await tx.update(chefDishes).set({ modifierGroupIds: [...ids, group.id] }).where(eq(chefDishes.id, dish.id));
    }
    const links = await tx.select().from(chefDishExtras).where(eq(chefDishExtras.dishId, dish.id));
    const keep: string[] = [];
    for (const [i, e] of extras.entries()) {
      let link = links.find((l) => l.extraId === e.id);
      if (!link) {
        [link] = await tx.insert(chefDishExtras).values({ dishId: dish.id, extraId: e.id, optionId: randomUUID() }).returning();
      }
      keep.push(link.optionId);
      const ov = { groupId: group.id, name: e.name, priceCents: e.priceCents, soldOut: e.soldOut, maxQty: e.maxQty, portionDesc: e.portionDesc, prepMinutesDelta: e.prepMinutesDelta, addsAllergens: e.allergens, removesDietaryTags: e.removesDietaryTags, searchTerms: e.synonyms, sortOrder: i };
      await tx.insert(modifierOptions).values({ id: link.optionId, ...ov }).onConflictDoUpdate({ target: modifierOptions.id, set: ov });
    }
    const gone = links.filter((l) => !keep.includes(l.optionId));
    if (gone.length) {
      await tx.delete(chefDishExtras).where(and(eq(chefDishExtras.dishId, dish.id), inArray(chefDishExtras.extraId, gone.map((l) => l.extraId))));
      await tx.delete(modifierOptions).where(inArray(modifierOptions.id, gone.map((l) => l.optionId)));
    }
  }

  async syncExtrasForChef(chefProfileId: string) {
    const dishes = await this.db.select().from(chefDishes).where(eq(chefDishes.chefProfileId, chefProfileId));
    for (const d of dishes) await this.syncExtrasForDish(d);
    if (dishes[0]) await this.invalidate(dishes[0].locationId);
  }

  /** Customer-facing groups of a dish (materialized, in order). */
  async groupsForDish(dish: Pick<Dish, 'menuItemId'>): Promise<ModGroup[]> {
    const links = await this.db.select().from(itemModifierGroups).where(eq(itemModifierGroups.itemId, dish.menuItemId)).orderBy(asc(itemModifierGroups.sortOrder));
    if (!links.length) return [];
    const gs = await this.db.select().from(modifierGroups).where(inArray(modifierGroups.id, links.map((l) => l.groupId)));
    const os = await this.db.select().from(modifierOptions).where(inArray(modifierOptions.groupId, gs.map((g) => g.id))).orderBy(asc(modifierOptions.sortOrder));
    return links.map((l) => gs.find((g) => g.id === l.groupId)!).filter(Boolean).map((g) => ({
      id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, required: g.required, selectionType: g.selectionType as ModGroup['selectionType'], parentOptionId: g.parentOptionId, description: g.description, templateKey: g.templateKey, isExtras: g.isExtras,
      options: os.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, name: o.name, priceCents: o.priceCents, soldOut: o.soldOut, isDefault: o.isDefault, maxQty: o.maxQty, portionDesc: o.portionDesc, prepMinutesDelta: o.prepMinutesDelta, addsAllergens: o.addsAllergens, removesDietaryTags: o.removesDietaryTags, locked: o.locked, rules: o.rules as Record<string, never>, description: o.description, searchTerms: o.searchTerms })),
    }));
  }

  /** Price a customization without creating a quote (dish page "price updates immediately"). */
  async price(dishId: string, optionIds: string[]) {
    const [r] = await this.db.select({ d: chefDishes, i: menuItems }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(eq(chefDishes.id, dishId)).limit(1);
    if (!r || r.d.reviewStatus !== 'PUBLISHED') throw new NotFoundException('Dish not available');
    const ev = evaluateCustomization(r.d.dishName, await this.groupsForDish(r.d), optionIds, { allergens: r.i.allergens, dietaryTags: r.i.dietaryTags });
    return { ...ev, basePriceCents: r.i.priceCents, unitPriceCents: r.i.priceCents + ev.modifiersCents, prepMinutes: r.d.prepMinutes + ev.prepMinutesDelta };
  }

  // ───── chef: option sold out (operational, no review) ─────

  async setOptionSoldOut(user: JwtPayload, dishId: string, optionId: string, soldOut: boolean) {
    const p = await this.chefs.myProfile(user);
    const [d] = await this.db.select().from(chefDishes).where(eq(chefDishes.id, dishId)).limit(1);
    if (!d || d.chefProfileId !== p.id) throw new ForbiddenException('Not your dish');
    const cfg = (d.optionsConfig as OptionsConfigGroup[]).map((g) => ({ ...g, options: g.options.map((o) => (o.id === optionId ? { ...o, soldOut } : o)) }));
    if (!cfg.some((g) => g.options.some((o) => o.id === optionId))) throw new NotFoundException('Option not found');
    await this.db.update(chefDishes).set({ optionsConfig: cfg }).where(eq(chefDishes.id, dishId));
    if (d.modifierGroupIds.length) await this.db.update(modifierOptions).set({ soldOut }).where(and(eq(modifierOptions.id, optionId), inArray(modifierOptions.groupId, d.modifierGroupIds)));
    await this.invalidate(d.locationId);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: soldOut ? 'chef.option.sold_out' : 'chef.option.back', entityType: 'chef_dish', entityId: dishId, after: { optionId } });
    return { ok: true, soldOut };
  }

  // ───── chef: extras catalog ─────

  async listExtras(user: JwtPayload) {
    const p = await this.chefs.myProfile(user);
    return this.db.select().from(chefExtras).where(and(eq(chefExtras.chefProfileId, p.id), eq(chefExtras.active, true))).orderBy(asc(chefExtras.name));
  }

  private async ownDishIds(profileId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db.select({ id: chefDishes.id }).from(chefDishes).where(and(inArray(chefDishes.id, ids), eq(chefDishes.chefProfileId, profileId)));
    if (rows.length !== new Set(ids).size) throw new BadRequestException('Unknown dish');
    return rows.map((r) => r.id);
  }

  /**
   * New extras and changes to their name or allergens need Gutad approval (they change what customers eat);
   * price, portion limit, sold out and which dishes offer them apply immediately to approved extras.
   */
  async upsertExtra(user: JwtPayload, id: string | null, input: { name?: string; synonyms?: string[]; portionDesc?: string | null; priceCents?: number; maxQty?: number; prepMinutesDelta?: number; allergens?: string[]; removesDietaryTags?: string[]; allDishes?: boolean; dishIds?: string[]; soldOut?: boolean }) {
    const p = await this.chefs.myProfile(user);
    const dishIds = input.dishIds ? await this.ownDishIds(p.id, input.dishIds) : undefined;
    let row: Extra;
    if (!id) {
      if (!input.name?.trim()) throw new BadRequestException('Name the extra');
      [row] = await this.db.insert(chefExtras).values({ chefProfileId: p.id, name: input.name.trim(), synonyms: (input.synonyms || []).map((s) => s.trim().toLowerCase()).filter(Boolean), portionDesc: input.portionDesc || null, priceCents: input.priceCents ?? 0, maxQty: input.maxQty ?? 2, prepMinutesDelta: input.prepMinutesDelta ?? 0, allergens: input.allergens || [], removesDietaryTags: input.removesDietaryTags || [], allDishes: !!input.allDishes, dishIds: dishIds || [], status: 'PENDING' }).returning();
    } else {
      const [cur] = await this.db.select().from(chefExtras).where(eq(chefExtras.id, id)).limit(1);
      if (!cur || cur.chefProfileId !== p.id) throw new NotFoundException('Extra not found');
      const material = (input.name !== undefined && input.name.trim() !== cur.name) || (input.allergens !== undefined && JSON.stringify([...input.allergens].sort()) !== JSON.stringify([...cur.allergens].sort())) || (input.removesDietaryTags !== undefined && JSON.stringify(input.removesDietaryTags) !== JSON.stringify(cur.removesDietaryTags));
      [row] = await this.db
        .update(chefExtras)
        .set({ ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.synonyms ? { synonyms: input.synonyms.map((s) => s.trim().toLowerCase()).filter(Boolean) } : {}), ...(input.portionDesc !== undefined ? { portionDesc: input.portionDesc } : {}), ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}), ...(input.maxQty !== undefined ? { maxQty: input.maxQty } : {}), ...(input.prepMinutesDelta !== undefined ? { prepMinutesDelta: input.prepMinutesDelta } : {}), ...(input.allergens ? { allergens: input.allergens } : {}), ...(input.removesDietaryTags ? { removesDietaryTags: input.removesDietaryTags } : {}), ...(input.allDishes !== undefined ? { allDishes: input.allDishes } : {}), ...(dishIds ? { dishIds } : {}), ...(input.soldOut !== undefined ? { soldOut: input.soldOut } : {}), ...(material ? { status: 'PENDING', reviewNote: null } : {}) })
        .where(eq(chefExtras.id, id))
        .returning();
    }
    await this.syncExtrasForChef(p.id);
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: id ? 'chef.extra.update' : 'chef.extra.create', entityType: 'chef_extra', entityId: row.id, after: input });
    return row;
  }

  async removeExtra(user: JwtPayload, id: string) {
    const p = await this.chefs.myProfile(user);
    const [cur] = await this.db.select().from(chefExtras).where(eq(chefExtras.id, id)).limit(1);
    if (!cur || cur.chefProfileId !== p.id) throw new NotFoundException('Extra not found');
    await this.db.update(chefExtras).set({ active: false }).where(eq(chefExtras.id, id));
    await this.syncExtrasForChef(p.id);
    return { ok: true };
  }

  // ───── Gutad: extras review ─────

  async extrasQueue(user: JwtPayload) {
    assertCan(user, 'chefs.read');
    return this.db.select({ e: chefExtras, chef: chefProfiles.displayName }).from(chefExtras).innerJoin(chefProfiles, eq(chefProfiles.id, chefExtras.chefProfileId)).where(and(eq(chefExtras.status, 'PENDING'), eq(chefExtras.active, true))).orderBy(asc(chefExtras.createdAt)).then((rows) => rows.map((r) => ({ ...r.e, chefName: r.chef })));
  }

  async reviewExtra(user: JwtPayload, id: string, input: { approve: boolean; note?: string }) {
    assertCan(user, 'chefs.manage');
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    if (!input.approve && (input.note || '').trim().length < 5) throw new BadRequestException({ message: 'Add a note for the chef', code: 'REASON_REQUIRED' });
    const [e] = await this.db.update(chefExtras).set({ status: input.approve ? 'APPROVED' : 'REJECTED', reviewNote: input.note || null }).where(eq(chefExtras.id, id)).returning();
    if (!e) throw new NotFoundException();
    await this.syncExtrasForChef(e.chefProfileId);
    await this.audit.log({ actorId: user.sub, action: input.approve ? 'chef.extra.approve' : 'chef.extra.reject', entityType: 'chef_extra', entityId: id, reason: input.note || null });
    return e;
  }
}
