import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { ingredients, menuCategories, menuItems, menus, orgMemberships, recipeAcknowledgments, recipeLines, recipes, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { assertOrgAccess, can, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';

type Recipe = typeof recipes.$inferSelect;
export interface RecipeInput {
  name: string;
  yieldPortions?: number;
  laborMinutes?: number;
  portionSize?: string | null;
  steps?: { n: number; text: string; stationCode?: string; minutes?: number }[];
  substitutions?: { ingredientId: string; substituteId: string; ratio?: number; approved?: boolean }[];
  equipment?: string[];
  prepMinutes?: number;
  batchMaxPortions?: number | null;
  trainingUrl?: string | null;
  trainingNotes?: string | null;
  changeSummary?: string | null;
  lines?: { ingredientId: string; quantity: number }[];
}
const KITCHEN_ROLES = ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'KITCHEN'] as const;

/** 8 — recipes per merchant: versions, steps, substitutions, equipment, trials, release approval, training & acknowledgments, cost & profitability, allergen traceability. */
@Injectable()
export class RecipesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly notify: NotifyService, private readonly settings: SettingsService) {}

  private async recipe(id: string) {
    const [r] = await this.db.select().from(recipes).where(eq(recipes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Recipe not found');
    return r;
  }

  private access(user: JwtPayload, r: Recipe, write = false) {
    if (!r.organizationId) {
      if (write && !can(user, 'culinary.manage')) throw new ForbiddenException('Shared catalog recipes are maintained by Gutad culinary');
      return;
    }
    if (isPlatformStaff(user) && can(user, write ? 'culinary.manage' : 'kitchens.read')) return;
    assertOrgAccess(user, r.organizationId, null, write ? [...KITCHEN_ROLES] : undefined);
  }

  async laborRate() {
    return this.settings.get<number>('ops.labor_rate_cents_per_hour', 1800);
  }

  /** Plate cost per portion and the profitability of every menu item that uses the recipe. */
  async costing(r: Recipe) {
    const lines = await this.db.select({ line: recipeLines, ing: ingredients }).from(recipeLines).innerJoin(ingredients, eq(ingredients.id, recipeLines.ingredientId)).where(eq(recipeLines.recipeId, r.id));
    const rate = await this.laborRate();
    const ingredientCents = lines.reduce((a, { line, ing }) => a + line.quantity * ing.costCentsPerUnit, 0) / (r.yieldPortions || 1);
    const laborCents = ((r.laborMinutes / 60) * rate) / (r.yieldPortions || 1);
    const plate = Math.round(ingredientCents + laborCents);
    const items = await this.db.select({ id: menuItems.id, name: menuItems.name, priceCents: menuItems.priceCents, allergens: menuItems.allergens, allergenReviewNeeded: menuItems.allergenReviewNeeded, menu: menus.name }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.recipeId, r.id));
    return {
      lines: lines.map(({ line, ing }) => ({ id: line.id, ingredientId: ing.id, name: ing.name, unit: ing.unit, quantity: line.quantity, unitCostCents: ing.costCentsPerUnit, costCents: Math.round(line.quantity * ing.costCentsPerUnit), allergens: ing.allergens })),
      ingredientCentsPerPortion: Math.round(ingredientCents),
      laborCentsPerPortion: Math.round(laborCents),
      plateCostCents: plate,
      allergens: [...new Set(lines.flatMap((l) => l.ing.allergens.map((a) => a.toLowerCase())))],
      items: items.map((i) => ({ ...i, marginCents: i.priceCents - plate, marginPct: i.priceCents ? (i.priceCents - plate) / i.priceCents : null, foodCostPct: i.priceCents ? plate / i.priceCents : null })),
    };
  }

  async list(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const rows = await this.db.select().from(recipes).where(or(eq(recipes.organizationId, orgId), isNull(recipes.organizationId))).orderBy(recipes.name, desc(recipes.version));
    const out = [];
    for (const r of rows) {
      const c = await this.costing(r);
      out.push({ id: r.id, name: r.name, version: r.version, status: r.status, isActive: r.isActive, shared: !r.organizationId, portionSize: r.portionSize, yieldPortions: r.yieldPortions, plateCostCents: c.plateCostCents, allergens: c.allergens, items: c.items.length, lowestMarginPct: c.items.length ? Math.min(...c.items.map((i) => i.marginPct ?? 1)) : null, createdAt: r.createdAt });
    }
    return out;
  }

  async detail(user: JwtPayload, id: string) {
    const r = await this.recipe(id);
    this.access(user, r);
    const chain: Recipe[] = [];
    let prev = r.previousRecipeId;
    while (prev && chain.length < 20) { const p = await this.recipe(prev).catch(() => null); if (!p) break; chain.push(p); prev = p.previousRecipeId; }
    const next = await this.db.select({ id: recipes.id, version: recipes.version, status: recipes.status }).from(recipes).where(eq(recipes.previousRecipeId, id));
    const acks = await this.db.select({ userId: recipeAcknowledgments.userId, at: recipeAcknowledgments.createdAt, email: users.email }).from(recipeAcknowledgments).innerJoin(users, eq(users.id, recipeAcknowledgments.userId)).where(eq(recipeAcknowledgments.recipeId, id));
    const kitchenStaff = r.organizationId ? await this.db.select({ userId: orgMemberships.userId, email: users.email, role: orgMemberships.role }).from(orgMemberships).innerJoin(users, eq(users.id, orgMemberships.userId)).where(and(eq(orgMemberships.organizationId, r.organizationId), inArray(orgMemberships.role, ['KITCHEN', 'MERCHANT_MANAGER', 'PACKER']))) : [];
    const subIds = [...new Set((r.substitutions as { ingredientId: string; substituteId: string }[]).flatMap((s) => [s.ingredientId, s.substituteId]))];
    const subIngs = subIds.length ? await this.db.select({ id: ingredients.id, name: ingredients.name, allergens: ingredients.allergens }).from(ingredients).where(inArray(ingredients.id, subIds)) : [];
    return {
      recipe: r,
      costing: await this.costing(r),
      laborRateCentsPerHour: await this.laborRate(),
      history: chain.map((c) => ({ id: c.id, version: c.version, status: c.status, changeSummary: c.changeSummary, approvedAt: c.approvedAt, createdAt: c.createdAt })),
      newerVersions: next,
      substitutions: (r.substitutions as { ingredientId: string; substituteId: string; ratio?: number; approved?: boolean }[]).map((s) => ({ ...s, ingredient: subIngs.find((i) => i.id === s.ingredientId)?.name, substitute: subIngs.find((i) => i.id === s.substituteId)?.name, substituteAllergens: subIngs.find((i) => i.id === s.substituteId)?.allergens || [] })),
      acknowledgments: acks,
      awaitingAcknowledgment: r.status === 'APPROVED' ? kitchenStaff.filter((k) => !acks.some((a) => a.userId === k.userId)) : [],
    };
  }

  async create(user: JwtPayload, orgId: string, input: RecipeInput & { previousRecipeId?: string }) {
    assertOrgAccess(user, orgId, null, [...KITCHEN_ROLES]);
    let version = 1;
    if (input.previousRecipeId) {
      const prev = await this.recipe(input.previousRecipeId);
      if (prev.organizationId && prev.organizationId !== orgId) throw new ForbiddenException();
      const [open] = await this.db.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.previousRecipeId, prev.id), inArray(recipes.status, ['DRAFT', 'TRIAL']))).limit(1);
      if (open) throw new ConflictException('A newer version of this recipe is already in progress');
      version = prev.version + 1;
      input = { ...{ name: prev.name, yieldPortions: prev.yieldPortions, laborMinutes: prev.laborMinutes, portionSize: prev.portionSize, steps: prev.steps as RecipeInput['steps'], substitutions: prev.substitutions as RecipeInput['substitutions'], equipment: prev.equipment, prepMinutes: prev.prepMinutes, batchMaxPortions: prev.batchMaxPortions, trainingUrl: prev.trainingUrl, trainingNotes: prev.trainingNotes, lines: (await this.db.select({ ingredientId: recipeLines.ingredientId, quantity: recipeLines.quantity }).from(recipeLines).where(eq(recipeLines.recipeId, prev.id))) }, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as RecipeInput & { previousRecipeId?: string };
    }
    const { lines, previousRecipeId, ...rest } = input;
    const r = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(recipes).values({ ...(rest as Record<string, unknown>), name: input.name, organizationId: orgId, version, status: 'DRAFT', isActive: false, previousRecipeId: previousRecipeId ?? null, createdById: user.sub } as never).returning();
      if (lines?.length) await tx.insert(recipeLines).values(lines.map((l) => ({ ...l, recipeId: row.id })));
      return row;
    });
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'recipe.create', entityType: 'recipe', entityId: r.id, after: { name: r.name, version } });
    return r;
  }

  async update(user: JwtPayload, id: string, input: Partial<RecipeInput>) {
    const r = await this.recipe(id);
    this.access(user, r, true);
    if (!['DRAFT', 'TRIAL'].includes(r.status)) throw new ConflictException('Approved recipes are changed by creating a new version');
    const { lines, ...rest } = input;
    await this.db.transaction(async (tx) => {
      if (Object.keys(rest).length) await tx.update(recipes).set(rest as never).where(eq(recipes.id, id));
      if (lines) {
        await tx.delete(recipeLines).where(eq(recipeLines.recipeId, id));
        if (lines.length) await tx.insert(recipeLines).values(lines.map((l) => ({ ...l, recipeId: id })));
      }
    });
    return this.detail(user, id);
  }

  async trial(user: JwtPayload, id: string, input: { notes: string; score?: number; location?: string }) {
    const r = await this.recipe(id);
    this.access(user, r, true);
    if (!['DRAFT', 'TRIAL'].includes(r.status)) throw new ConflictException('Only drafts go to test-kitchen trials');
    const trials = [...(r.trials as unknown[]), { at: new Date().toISOString(), by: user.email, notes: input.notes, score: input.score ?? null, location: input.location ?? null }];
    const [row] = await this.db.update(recipes).set({ status: 'TRIAL', trials }).where(eq(recipes.id, id)).returning();
    return row;
  }

  /**
   * Release approval: someone other than the author (the merchant owner/manager or Gutad culinary) approves.
   * The recipe goes live, replaces the previous version on every menu item, and items whose listed allergens
   * miss an allergen in the new recipe are flagged for review (traceability recipe → allergens → menu).
   */
  async approve(user: JwtPayload, id: string, note: string) {
    const r = await this.recipe(id);
    const staff = isPlatformStaff(user) && can(user, 'culinary.manage');
    if (!staff) {
      if (!r.organizationId) throw new ForbiddenException();
      assertOrgAccess(user, r.organizationId, null, MANAGER_ROLES);
    }
    if (r.createdById === user.sub && !user.roles.includes('PLATFORM_ADMIN')) throw new ForbiddenException({ message: 'Someone other than the author approves a recipe release', code: 'SELF_APPROVAL' });
    if (!['DRAFT', 'TRIAL'].includes(r.status)) throw new ConflictException(`Recipe is ${r.status}`);
    const requireTrial = await this.settings.get<boolean>('recipes.require_trial', false);
    if (requireTrial && !(r.trials as unknown[]).length) throw new BadRequestException('Record a test-kitchen trial before release');
    const cost = await this.costing(r);
    const flagged: { id: string; name: string; missing: string[] }[] = [];
    await this.db.transaction(async (tx) => {
      await tx.update(recipes).set({ status: 'APPROVED', isActive: true, approvedById: user.sub, approvedAt: new Date() }).where(eq(recipes.id, id));
      if (r.previousRecipeId) {
        await tx.update(recipes).set({ status: 'RETIRED', isActive: false }).where(eq(recipes.id, r.previousRecipeId));
        await tx.update(menuItems).set({ recipeId: id }).where(eq(menuItems.recipeId, r.previousRecipeId));
      }
      const items = await tx.select({ id: menuItems.id, name: menuItems.name, allergens: menuItems.allergens }).from(menuItems).where(eq(menuItems.recipeId, id));
      for (const it of items) {
        const listed = it.allergens.map((a) => a.toLowerCase());
        const missing = cost.allergens.filter((a) => !listed.includes(a));
        if (missing.length) {
          flagged.push({ id: it.id, name: it.name, missing });
          await tx.update(menuItems).set({ allergenReviewNeeded: true }).where(eq(menuItems.id, it.id));
        }
      }
    });
    await this.audit.log({ organizationId: r.organizationId, actorId: user.sub, action: 'recipe.approve', entityType: 'recipe', entityId: id, after: { version: r.version, plateCostCents: cost.plateCostCents, flagged }, reason: note });
    if (r.organizationId) {
      const staffRows = await this.db.select({ userId: orgMemberships.userId }).from(orgMemberships).where(and(eq(orgMemberships.organizationId, r.organizationId), inArray(orgMemberships.role, ['KITCHEN', 'MERCHANT_MANAGER'])));
      for (const s of staffRows) await this.notify.queue({ userId: s.userId, template: 'recipe.changed', payload: { name: r.name, version: r.version, summary: r.changeSummary }, channels: ['IN_APP', 'PUSH'], dedupeKey: `recipe:${id}:${s.userId}` });
    }
    return { recipe: await this.recipe(id), allergenReview: flagged };
  }

  /** Gutad culinary: recipes waiting for release across merchants, and menu items flagged for allergen review. */
  async culinaryQueue(user: JwtPayload) {
    if (!can(user, 'culinary.manage') && !can(user, 'catalog.read')) throw new ForbiddenException();
    const pending = await this.db.select({ r: recipes, email: users.email }).from(recipes).leftJoin(users, eq(users.id, recipes.createdById)).where(inArray(recipes.status, ['DRAFT', 'TRIAL'])).orderBy(desc(recipes.createdAt)).limit(200);
    const flagged = await this.db.select({ id: menuItems.id, name: menuItems.name, allergens: menuItems.allergens, organizationId: menus.organizationId, menu: menus.name }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menuItems.allergenReviewNeeded, true)).limit(200);
    return { recipes: pending.map((p) => ({ id: p.r.id, name: p.r.name, version: p.r.version, status: p.r.status, organizationId: p.r.organizationId, authorEmail: p.email, trials: (p.r.trials as unknown[]).length, changeSummary: p.r.changeSummary, createdAt: p.r.createdAt })), allergenFlags: flagged };
  }

  async acknowledge(user: JwtPayload, id: string) {
    const r = await this.recipe(id);
    this.access(user, r);
    if (r.status !== 'APPROVED') throw new ConflictException('Only released recipes are acknowledged');
    await this.db.insert(recipeAcknowledgments).values({ recipeId: id, userId: user.sub }).onConflictDoNothing();
    return { ok: true };
  }

  async allergenReview(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const items = await this.db.select({ id: menuItems.id, name: menuItems.name, allergens: menuItems.allergens, recipeId: menuItems.recipeId, menu: menus.name }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(and(eq(menus.organizationId, orgId), eq(menuItems.allergenReviewNeeded, true)));
    const out = [];
    for (const i of items) {
      const derived = i.recipeId ? (await this.costing(await this.recipe(i.recipeId))).allergens : [];
      out.push({ ...i, fromRecipe: derived, missing: derived.filter((a) => !i.allergens.map((x) => x.toLowerCase()).includes(a)) });
    }
    return out;
  }

  // ───── ingredients: shared catalog (Gutad culinary) and merchant-owned ─────

  async listIngredients(user: JwtPayload, orgId?: string) {
    if (orgId) assertOrgAccess(user, orgId);
    return this.db.select().from(ingredients).where(orgId ? or(isNull(ingredients.organizationId), eq(ingredients.organizationId, orgId)) : isNull(ingredients.organizationId)).orderBy(ingredients.name);
  }

  async upsertIngredient(user: JwtPayload, input: { id?: string; organizationId?: string | null; name: string; unit: string; costCentsPerUnit?: number; allergens?: string[] }) {
    const orgId = input.organizationId ?? null;
    if (orgId) assertOrgAccess(user, orgId, null, [...KITCHEN_ROLES]);
    else if (!can(user, 'culinary.manage') && !can(user, 'catalog.manage')) throw new ForbiddenException('The shared ingredient catalog is maintained by Gutad culinary; add your own ingredients to your organization');
    const values = { name: input.name, unit: input.unit, costCentsPerUnit: input.costCentsPerUnit ?? 0, allergens: (input.allergens || []).map((a) => a.toLowerCase()), organizationId: orgId };
    let row;
    if (input.id) {
      const [ex] = await this.db.select().from(ingredients).where(eq(ingredients.id, input.id)).limit(1);
      if (!ex) throw new NotFoundException();
      if ((ex.organizationId ?? null) !== orgId) throw new ForbiddenException('Ingredient belongs to another catalog');
      [row] = await this.db.update(ingredients).set({ ...values, costCentsPerUnit: input.costCentsPerUnit ?? ex.costCentsPerUnit, allergens: input.allergens ? values.allergens : ex.allergens }).where(eq(ingredients.id, input.id)).returning();
      if (input.allergens && JSON.stringify(ex.allergens) !== JSON.stringify(values.allergens)) await this.flagItemsUsing(input.id);
    } else {
      const [ex] = await this.db.select().from(ingredients).where(and(eq(ingredients.name, input.name), orgId ? eq(ingredients.organizationId, orgId) : isNull(ingredients.organizationId))).limit(1);
      [row] = ex ? await this.db.update(ingredients).set(values).where(eq(ingredients.id, ex.id)).returning() : await this.db.insert(ingredients).values(values).returning();
    }
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'ingredient.upsert', entityType: 'ingredient', entityId: row.id, after: row });
    return row;
  }

  /** An ingredient's allergens changed: every item whose recipe uses it gets an allergen review. */
  private async flagItemsUsing(ingredientId: string) {
    await this.db.execute(sql`update menu_items set allergen_review_needed = true where recipe_id in (select recipe_id from recipe_lines where ingredient_id = ${ingredientId})`);
  }
}
