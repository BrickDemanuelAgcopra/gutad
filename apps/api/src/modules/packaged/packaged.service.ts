import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { needsReview, normalizeGtin, PACKAGED_CATEGORIES, sellerAllowed, sizeLabel, type LotAdjustKind, type PackagedCategory, type PackagedGoodsPolicy, type PackagedStorage, type RecallScope } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { locations, menuCategories, menuItems, menus, organizations, orderLines, orders, packagedProducts, platformSettings, productAllocations, productLots, productRecalls, productStockMovements } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { FirstPartyService } from '../../core/first-party.service';
import { OutboxService } from '../../core/outbox.service';
import { PackagedStockService } from '../../core/packaged-stock.service';
import { RedisService } from '../../core/redis.service';
import { shortCode } from '../../common/utils';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const OPEN_ORDER = ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY'];

export interface ProductInput {
  name: string;
  description?: string | null;
  priceCents: number;
  imageUrl?: string | null;
  allergens?: string[];
  dietaryTags?: string[];
  maxPerOrder?: number | null;
  taxCategory?: string;
  sku?: string | null;
  gtin?: string | null;
  brandName?: string | null;
  size?: number | null;
  sizeUom?: string | null;
  unitCount?: number;
  category: PackagedCategory;
  storage: PackagedStorage;
  dateType: 'BEST_BEFORE' | 'USE_BY' | 'NONE';
  minRemainingDays?: number | null;
  ingredientsText?: string | null;
  countryOfOrigin?: string | null;
  labelImageUrl?: string | null;
  lowStockThreshold?: number;
}

/** Fields printed on the pack: changing one sends an approved product back to review. */
const LABEL_FIELDS = ['name', 'gtin', 'brandName', 'size', 'sizeUom', 'unitCount', 'category', 'storage', 'dateType', 'ingredientsText', 'allergens', 'countryOfOrigin', 'labelImageUrl'] as const;
const ITEM_FIELDS = ['name', 'description', 'imageUrl', 'allergens', 'dietaryTags', 'maxPerOrder', 'taxCategory'] as const;
const PRODUCT_FIELDS = ['sku', 'gtin', 'brandName', 'size', 'sizeUom', 'unitCount', 'category', 'storage', 'dateType', 'minRemainingDays', 'ingredientsText', 'countryOfOrigin', 'labelImageUrl', 'lowStockThreshold'] as const;

/** Packaged goods for merchants (catalog, stock, batches, recalls) and for Gutad staff (review, policy, recalls, report). */
@Injectable()
export class PackagedService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stock: PackagedStockService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
    private readonly firstParty: FirstPartyService,
  ) {}

  // ───── helpers ─────

  private async location(locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  /** Item + its menu (the menu decides the owning organization and home location). */
  private async itemWithMenu(itemId: string, tx: DbOrTx = this.db) {
    const [r] = await tx.select({ item: menuItems, menu: menus, product: packagedProducts }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).leftJoin(packagedProducts, eq(packagedProducts.menuItemId, menuItems.id)).where(eq(menuItems.id, itemId)).limit(1);
    if (!r) throw new NotFoundException('Product not found');
    return r;
  }

  private async requireProduct(user: JwtPayload, itemId: string, manage = false, tx: DbOrTx = this.db) {
    const r = await this.itemWithMenu(itemId, tx);
    if (!r.product) throw new NotFoundException('This item is not a packaged product');
    assertOrgAccess(user, r.menu.organizationId, r.menu.locationId, manage ? MANAGER_ROLES : undefined);
    return { ...r, product: r.product };
  }

  /** Locations a menu is sold at: its own plus locations it is shared to. */
  private async locationsForMenu(menuId: string, home: string | null, tx: DbOrTx = this.db) {
    const linked = rows<{ location_id: string }>(await tx.execute(sql`select location_id from menu_location_links where menu_id = ${menuId}`));
    return [...new Set([...(home ? [home] : []), ...linked.map((x) => x.location_id)])];
  }

  private async invalidate(locationIds: string[]) {
    if (!locationIds.length) return;
    const ls = await this.db.select({ id: locations.id, slug: locations.slug }).from(locations).where(inArray(locations.id, locationIds));
    const keys = ls.flatMap((l) => [`loc:${l.id}`, `loc:${l.slug}`]);
    if (keys.length) await this.redis.del(...keys).catch(() => undefined);
  }

  private async invalidateItem(itemId: string) {
    const r = await this.itemWithMenu(itemId);
    await this.invalidate(await this.locationsForMenu(r.menu.id, r.menu.locationId));
  }

  private validate(p: PackagedGoodsPolicy, orgId: string, input: Partial<ProductInput>, firstParty: boolean) {
    if (input.category && !PACKAGED_CATEGORIES.includes(input.category)) throw new BadRequestException({ message: 'Unknown category', code: 'PACKAGED_CATEGORY' });
    if (input.category && !p.categories[input.category].allowed) throw new BadRequestException({ message: 'Gutad does not allow this kind of product right now', code: 'PACKAGED_CATEGORY_BLOCKED' });
    if (!firstParty && !sellerAllowed(p, orgId)) throw new ForbiddenException({ message: 'Your store is not enabled for packaged goods. Contact Gutad.', code: 'PACKAGED_SELLER_BLOCKED' });
    let gtin: string | null | undefined = input.gtin;
    if (input.gtin) {
      gtin = normalizeGtin(input.gtin);
      if (!gtin) throw new BadRequestException({ message: 'That barcode (GTIN/UPC/EAN) is not valid. Check the digits.', code: 'GTIN_INVALID' });
    }
    return gtin;
  }

  // ───── merchant: catalog ─────

  async createProduct(user: JwtPayload, categoryId: string, input: ProductInput) {
    const [cat] = await this.db.select().from(menuCategories).where(eq(menuCategories.id, categoryId)).limit(1);
    if (!cat) throw new NotFoundException('Category not found');
    const [m] = await this.db.select().from(menus).where(eq(menus.id, cat.menuId)).limit(1);
    if (!m) throw new NotFoundException('Menu not found');
    assertOrgAccess(user, m.organizationId, m.locationId, MANAGER_ROLES);
    if (m.locationId && (await this.location(m.locationId)).chefKitchen) throw new BadRequestException({ message: 'Chef Network kitchens cook to order and cannot sell packaged goods', code: 'PACKAGED_NOT_FOR_CHEFS' });
    const p = await this.stock.policy();
    const fp = await this.firstParty.isFirstPartyOrg(m.organizationId);
    const gtin = this.validate(p, m.organizationId, input, fp);
    if (p.requireGtin && !gtin && input.category !== 'HOUSE_MADE') throw new BadRequestException({ message: 'A barcode (GTIN/UPC/EAN) is required', code: 'GTIN_REQUIRED' });
    if (p.requireLabelImage && !input.labelImageUrl) throw new BadRequestException({ message: 'A photo of the label is required', code: 'LABEL_IMAGE_REQUIRED' });
    const review = needsReview(p, input.category, fp);
    const out = await this.db.transaction(async (tx) => {
      const [item] = await tx.insert(menuItems).values({
        categoryId, name: input.name, description: input.description ?? null, priceCents: input.priceCents, imageUrl: input.imageUrl ?? null, photos: input.imageUrl ? [input.imageUrl] : [],
        allergens: input.allergens ?? [], dietaryTags: input.dietaryTags ?? [], kind: 'PACKAGED', taxCategory: input.taxCategory || p.categories[input.category].taxCategory,
        maxPerOrder: input.maxPerOrder ?? null, handling: input.storage === 'AMBIENT' ? [] : ['COLD'], cookMinutes: 0,
      }).returning();
      const [prod] = await tx.insert(packagedProducts).values({
        menuItemId: item.id, organizationId: m.organizationId, sku: input.sku ?? null, gtin: gtin ?? null, brandName: input.brandName ?? null, size: input.size ?? null, sizeUom: input.sizeUom ?? null, unitCount: input.unitCount ?? 1,
        category: input.category, storage: input.storage, dateType: input.dateType, minRemainingDays: input.minRemainingDays ?? null, ingredientsText: input.ingredientsText ?? null, countryOfOrigin: input.countryOfOrigin ?? null,
        labelImageUrl: input.labelImageUrl ?? null, lowStockThreshold: input.lowStockThreshold ?? 5, reviewStatus: review ? 'PENDING' : 'APPROVED', submittedAt: new Date(), reviewedAt: review ? null : new Date(), reviewNote: review ? null : 'Approved automatically (no review needed for this category)',
      }).returning();
      await this.audit.log({ organizationId: m.organizationId, actorId: user.sub, action: 'packaged.create', entityType: 'menu_item', entityId: item.id, after: { name: item.name, ...prod } }, tx);
      return { item, product: prod };
    });
    await this.invalidate(await this.locationsForMenu(m.id, m.locationId));
    return out;
  }

  async updateProduct(user: JwtPayload, itemId: string, input: Partial<ProductInput>) {
    const r = await this.requireProduct(user, itemId, true);
    const p = await this.stock.policy();
    const fp = await this.firstParty.isFirstPartyOrg(r.menu.organizationId);
    const gtin = this.validate(p, r.menu.organizationId, input, fp);
    const itemSet: Record<string, unknown> = {};
    const prodSet: Record<string, unknown> = {};
    for (const k of ITEM_FIELDS) if (input[k] !== undefined) itemSet[k] = input[k];
    for (const k of PRODUCT_FIELDS) if (input[k] !== undefined) prodSet[k] = k === 'gtin' ? gtin ?? null : input[k];
    if (input.storage) itemSet.handling = [...(r.item.handling || []).filter((h) => h !== 'COLD'), ...(input.storage === 'AMBIENT' ? [] : ['COLD'])];
    if (input.imageUrl !== undefined) itemSet.photos = input.imageUrl ? [input.imageUrl] : [];
    const before = { ...r.product, name: r.item.name, allergens: r.item.allergens } as Record<string, unknown>;
    const labelChanged = LABEL_FIELDS.some((k) => (k === 'name' || k === 'allergens' ? itemSet[k] : prodSet[k]) !== undefined && JSON.stringify(k === 'name' || k === 'allergens' ? itemSet[k] : prodSet[k]) !== JSON.stringify(before[k]));
    const category = (input.category || r.product.category) as PackagedCategory;
    if (labelChanged && r.product.reviewStatus === 'APPROVED' && needsReview(p, category, fp)) Object.assign(prodSet, { reviewStatus: 'PENDING', submittedAt: new Date(), reviewNote: 'Label details changed: waiting for review' });
    if (r.product.reviewStatus === 'SUSPENDED') delete prodSet.reviewStatus;
    await this.db.transaction(async (tx) => {
      if (Object.keys(itemSet).length) await tx.update(menuItems).set(itemSet).where(eq(menuItems.id, itemId));
      if (Object.keys(prodSet).length) await tx.update(packagedProducts).set(prodSet).where(eq(packagedProducts.menuItemId, itemId));
      await this.audit.log({ organizationId: r.menu.organizationId, actorId: user.sub, action: 'packaged.update', entityType: 'menu_item', entityId: itemId, before, after: { ...itemSet, ...prodSet } }, tx);
    });
    await this.invalidateItem(itemId);
    return this.productDetail(user, itemId);
  }

  /** A rejected product, fixed by the store, goes back to the review queue. */
  async resubmit(user: JwtPayload, itemId: string) {
    const r = await this.requireProduct(user, itemId, true);
    if (!['REJECTED', 'DRAFT'].includes(r.product.reviewStatus)) throw new ConflictException({ message: `The product is ${r.product.reviewStatus.toLowerCase()}`, code: 'PACKAGED_NOT_RESUBMITTABLE' });
    const p = await this.stock.policy();
    const review = needsReview(p, r.product.category as PackagedCategory, await this.firstParty.isFirstPartyOrg(r.menu.organizationId));
    await this.db.update(packagedProducts).set({ reviewStatus: review ? 'PENDING' : 'APPROVED', submittedAt: new Date(), reviewNote: null }).where(eq(packagedProducts.menuItemId, itemId));
    await this.audit.log({ organizationId: r.menu.organizationId, actorId: user.sub, action: 'packaged.resubmit', entityType: 'menu_item', entityId: itemId });
    await this.invalidateItem(itemId);
    return { reviewStatus: review ? 'PENDING' : 'APPROVED' };
  }

  async productDetail(user: JwtPayload, itemId: string) {
    const r = await this.requireProduct(user, itemId);
    return { item: r.item, product: r.product, size: sizeLabel(r.product.size, r.product.sizeUom, r.product.unitCount) };
  }

  /** Products offered at a location with stock, batches, expiring and low-stock lists. */
  async forLocation(user: JwtPayload, locationId: string) {
    const loc = await this.location(locationId);
    assertOrgAccess(user, loc.organizationId, locationId);
    const p = await this.stock.policy();
    const items = rows<{ id: string; name: string; price_cents: number; is_active: boolean; image_url: string | null; tax_category: string; menu_name: string; category_name: string; category_id: string }>(await this.db.execute(sql`
      select mi.id, mi.name, mi.price_cents, mi.is_active, mi.image_url, mi.tax_category, m.name as menu_name, c.name as category_name, c.id as category_id
      from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id
      where mi.kind = 'PACKAGED' and (m.location_id = ${locationId} or m.id in (select menu_id from menu_location_links where location_id = ${locationId}))
      order by m.name, c.sort_order, mi.sort_order, mi.name`));
    const ids = items.map((i) => i.id);
    const prods = ids.length ? await this.db.select().from(packagedProducts).where(inArray(packagedProducts.menuItemId, ids)) : [];
    const lots = ids.length ? await this.db.select().from(productLots).where(and(eq(productLots.locationId, locationId), inArray(productLots.menuItemId, ids))).orderBy(productLots.expiresOn, productLots.receivedAt) : [];
    const avail = await this.stock.available(locationId, ids, new Date(), this.db, p);
    const today = this.localToday(loc.timezone);
    const products = items.map((i) => {
      const prod = prods.find((x) => x.menuItemId === i.id)!;
      const myLots = lots.filter((l) => l.menuItemId === i.id);
      const live = myLots.filter((l) => l.status !== 'DEPLETED' || l.reserved > 0);
      const minDays = prod ? this.stock.minDays(p, prod) : null;
      const gate = prod ? this.stock.gate(p, prod) : 'Product details missing';
      const available = gate ? 0 : avail.get(i.id) ?? 0;
      return {
        itemId: i.id, name: i.name, priceCents: i.price_cents, isActive: i.is_active, imageUrl: i.image_url, taxCategory: i.tax_category, menuName: i.menu_name, categoryName: i.category_name, categoryId: i.category_id,
        product: prod, size: prod ? sizeLabel(prod.size, prod.sizeUom, prod.unitCount) : null, gate, minRemainingDays: minDays,
        available, onHand: live.reduce((a, l) => a + l.onHand, 0), reserved: live.reduce((a, l) => a + l.reserved, 0),
        lowStock: !gate && available <= (prod?.lowStockThreshold ?? 0),
        nextExpiry: live.find((l) => l.status === 'ACTIVE' && l.expiresOn)?.expiresOn ?? null,
        lots: live.map((l) => ({ ...l, sellBy: l.expiresOn && minDays != null ? this.addDays(l.expiresOn, -(minDays + (prod?.dateType === 'USE_BY' ? 1 : 0))) : null })),
      };
    });
    const expiringSoon = products.flatMap((x) => x.lots.filter((l) => {
      if (l.status !== 'ACTIVE' || !l.sellBy || l.onHand - l.reserved <= 0) return false;
      const near = p.nearExpiryDays[(x.product?.storage as PackagedStorage) || 'AMBIENT'] ?? 0;
      return l.sellBy <= this.addDays(today, near);
    }).map((l) => ({ itemId: x.itemId, name: x.name, lotId: l.id, lotCode: l.lotCode, expiresOn: l.expiresOn, sellBy: l.sellBy, units: l.onHand - l.reserved, pastSellBy: !!l.sellBy && l.sellBy < today })));
    const expired = products.flatMap((x) => x.lots.filter((l) => (l.status === 'EXPIRED' || l.status === 'RECALLED') && l.onHand - l.reserved > 0).map((l) => ({ itemId: x.itemId, name: x.name, lotId: l.id, lotCode: l.lotCode, status: l.status, expiresOn: l.expiresOn, units: l.onHand - l.reserved })));
    return {
      policy: { enabled: p.enabled, requireReview: p.requireReview, categories: p.categories, minRemainingDays: p.minRemainingDays, requireGtin: p.requireGtin, requireLabelImage: p.requireLabelImage, sellerAllowed: sellerAllowed(p, loc.organizationId) || (await this.firstParty.isFirstPartyOrg(loc.organizationId)) },
      chefKitchen: loc.chefKitchen,
      today,
      products,
      expiringSoon,
      toRemove: expired,
      lowStock: products.filter((x) => x.lowStock && x.product?.reviewStatus === 'APPROVED').map((x) => ({ itemId: x.itemId, name: x.name, available: x.available, threshold: x.product?.lowStockThreshold })),
    };
  }

  private localToday(tz: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  private addDays(ymd: string, n: number) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // ───── merchant: stock ─────

  async receive(user: JwtPayload, itemId: string, input: { locationId: string; quantity: number; lotCode?: string; expiresOn?: string | null; unitCostCents?: number; supplierName?: string }) {
    const r = await this.requireProduct(user, itemId);
    const loc = await this.location(input.locationId);
    assertOrgAccess(user, loc.organizationId, loc.id);
    if (loc.organizationId !== r.menu.organizationId) throw new ForbiddenException('This product belongs to another business');
    const sold = await this.locationsForMenu(r.menu.id, r.menu.locationId);
    if (!sold.includes(loc.id)) throw new BadRequestException({ message: 'This product is not on a menu at that location', code: 'PACKAGED_NOT_AT_LOCATION' });
    if (r.product.dateType !== 'NONE' && !input.expiresOn) throw new BadRequestException({ message: `Enter the ${r.product.dateType === 'USE_BY' ? 'use-by' : 'best-before'} date printed on the pack`, code: 'EXPIRY_REQUIRED' });
    if (input.expiresOn && input.expiresOn < this.localToday(loc.timezone)) throw new BadRequestException({ message: 'That date has already passed. Expired stock cannot be received.', code: 'EXPIRY_PAST' });
    const lotCode = (input.lotCode || '').trim() || `R${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${shortCode(4)}`;
    const lot = await this.db.transaction(async (tx) => {
      const [l] = await tx.insert(productLots).values({ menuItemId: itemId, locationId: loc.id, lotCode, expiresOn: r.product.dateType === 'NONE' ? null : input.expiresOn!, receivedQty: input.quantity, onHand: input.quantity, unitCostCents: input.unitCostCents ?? 0, supplierName: input.supplierName ?? null, receivedById: user.sub }).returning();
      await tx.insert(productStockMovements).values({ lotId: l.id, menuItemId: itemId, locationId: loc.id, kind: 'RECEIPT', quantity: input.quantity, reason: input.supplierName ? `From ${input.supplierName}` : 'Received', createdById: user.sub });
      return l;
    });
    await this.invalidate([loc.id]);
    return lot;
  }

  async adjust(user: JwtPayload, lotId: string, input: { kind: LotAdjustKind; quantity: number; reason: string }) {
    const [lot0] = await this.db.select().from(productLots).where(eq(productLots.id, lotId)).limit(1);
    if (!lot0) throw new NotFoundException('Batch not found');
    const loc = await this.location(lot0.locationId);
    assertOrgAccess(user, loc.organizationId, loc.id);
    const lot = await this.db.transaction(async (tx) => {
      const [l] = await tx.select().from(productLots).where(eq(productLots.id, lotId)).for('update');
      let onHand = l.onHand;
      if (input.kind === 'COUNT') onHand = input.quantity;
      else if (input.kind === 'ADJUSTMENT') onHand = l.onHand + input.quantity;
      else if (input.kind === 'WASTE') onHand = l.onHand - Math.abs(input.quantity);
      else if (input.kind === 'RETURN') onHand = l.onHand + Math.abs(input.quantity);
      if (onHand < l.reserved) throw new ConflictException({ message: `${l.reserved} unit${l.reserved === 1 ? ' is' : 's are'} held for open orders, so this batch can't go below ${l.reserved}`, code: 'STOCK_HELD', reserved: l.reserved });
      if (onHand < 0) throw new BadRequestException('Stock cannot go below zero');
      if (input.kind === 'RETURN' && l.status === 'RECALLED') throw new ConflictException({ message: 'A recalled batch cannot go back on sale', code: 'LOT_RECALLED' });
      const status = onHand === 0 && l.status === 'ACTIVE' ? 'DEPLETED' : onHand > 0 && l.status === 'DEPLETED' ? 'ACTIVE' : l.status;
      const [u] = await tx.update(productLots).set({ onHand, status }).where(eq(productLots.id, lotId)).returning();
      await tx.insert(productStockMovements).values({ lotId, menuItemId: l.menuItemId, locationId: l.locationId, kind: input.kind, quantity: onHand - l.onHand, reason: input.reason, createdById: user.sub });
      return u;
    });
    await this.invalidate([loc.id]);
    return lot;
  }

  async movements(user: JwtPayload, itemId: string, locationId: string) {
    const loc = await this.location(locationId);
    assertOrgAccess(user, loc.organizationId, locationId);
    return this.db.select({ m: productStockMovements, lotCode: productLots.lotCode, expiresOn: productLots.expiresOn, orderNumber: orders.number })
      .from(productStockMovements).innerJoin(productLots, eq(productLots.id, productStockMovements.lotId)).leftJoin(orders, eq(orders.id, productStockMovements.orderId))
      .where(and(eq(productStockMovements.menuItemId, itemId), eq(productStockMovements.locationId, locationId))).orderBy(desc(productStockMovements.createdAt)).limit(200)
      .then((rs) => rs.map((x) => ({ ...x.m, lotCode: x.lotCode, expiresOn: x.expiresOn, orderNumber: x.orderNumber })));
  }

  // ───── recalls (merchant and staff) ─────

  async merchantRecall(user: JwtPayload, locationId: string, input: { scope: RecallScope; lotIds?: string[]; itemId?: string; gtin?: string; reason: string; severity?: 'LOW' | 'HIGH' | 'CRITICAL' }) {
    const loc = await this.location(locationId);
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    return this.recall(user, { ...input, organizationId: loc.organizationId });
  }

  async staffRecall(user: JwtPayload, input: { scope: RecallScope; lotIds?: string[]; itemId?: string; gtin?: string; reason: string; severity?: 'LOW' | 'HIGH' | 'CRITICAL'; organizationId?: string | null }) {
    assertCan(user, 'catalog.manage');
    return this.recall(user, { ...input, organizationId: input.organizationId ?? null });
  }

  /**
   * Pulls batches from sale. Open orders holding units from them get the line marked unavailable (the customer picks a
   * replacement or a credit, and the units are written off). Customers who already received units get a safety notice.
   */
  private async recall(user: JwtPayload, input: { scope: RecallScope; lotIds?: string[]; itemId?: string; gtin?: string; reason: string; severity?: 'LOW' | 'HIGH' | 'CRITICAL'; organizationId: string | null }) {
    const conds = [];
    let gtin: string | null = null;
    if (input.scope === 'LOT') {
      if (!input.lotIds?.length) throw new BadRequestException('Choose the batches to recall');
      conds.push(inArray(productLots.id, input.lotIds));
    } else if (input.scope === 'PRODUCT') {
      if (!input.itemId) throw new BadRequestException('Choose the product to recall');
      conds.push(eq(productLots.menuItemId, input.itemId));
    } else {
      gtin = input.gtin ? normalizeGtin(input.gtin) : null;
      if (!gtin) throw new BadRequestException({ message: 'Enter a valid barcode (GTIN/UPC/EAN)', code: 'GTIN_INVALID' });
      conds.push(eq(packagedProducts.gtin, gtin));
    }
    if (input.organizationId) conds.push(eq(packagedProducts.organizationId, input.organizationId));
    const lots = await this.db.select({ lot: productLots, orgId: packagedProducts.organizationId, name: menuItems.name }).from(productLots).innerJoin(packagedProducts, eq(packagedProducts.menuItemId, productLots.menuItemId)).innerJoin(menuItems, eq(menuItems.id, productLots.menuItemId)).where(and(...conds));
    if (!lots.length) throw new BadRequestException({ message: 'No batches match this recall', code: 'RECALL_NO_MATCH' });
    const lotIds = lots.map((l) => l.lot.id);
    const title = `Recall: ${[...new Set(lots.map((l) => l.name))].slice(0, 3).join(', ')}`;
    const result = await this.db.transaction(async (tx) => {
      const [rec] = await tx.insert(productRecalls).values({ scope: input.scope, organizationId: input.organizationId, menuItemId: input.itemId ?? null, gtin, lotIds, reason: input.reason, severity: input.severity ?? 'HIGH', createdById: user.sub }).returning();
      await tx.update(productLots).set({ status: 'RECALLED' }).where(inArray(productLots.id, lotIds));
      for (const l of lots) await tx.insert(productStockMovements).values({ lotId: l.lot.id, menuItemId: l.lot.menuItemId, locationId: l.lot.locationId, kind: 'RECALL', quantity: 0, reason: `${input.reason} (${l.lot.onHand} on hand pulled from sale)`, createdById: user.sub });
      // open orders: the line becomes unavailable (trigger writes the held units off); the customer chooses replace or credit
      const held = await tx.select({ lineId: productAllocations.orderLineId, orderId: productAllocations.orderId, name: orderLines.name, number: orders.number }).from(productAllocations).innerJoin(orders, eq(orders.id, productAllocations.orderId)).innerJoin(orderLines, eq(orderLines.id, productAllocations.orderLineId)).where(and(inArray(productAllocations.lotId, lotIds), eq(productAllocations.status, 'RESERVED'), inArray(orders.status, OPEN_ORDER as never[])));
      const lineIds = [...new Set(held.map((h) => h.lineId))];
      for (const lineId of lineIds) {
        const h = held.find((x) => x.lineId === lineId)!;
        await tx.update(orderLines).set({ status: 'UNAVAILABLE', replacementNote: 'Recalled batch: not sent' }).where(eq(orderLines.id, lineId));
        await this.outbox.publish('order.line_unavailable', h.orderId, { lineId, name: h.name, number: h.number, note: 'This product was recalled, so it was not sent' }, tx);
      }
      // delivered orders: safety notice to each customer
      const sold = await tx.selectDistinct({ orderId: orders.id, number: orders.number, userId: orders.userId }).from(productAllocations).innerJoin(orders, eq(orders.id, productAllocations.orderId)).where(and(inArray(productAllocations.lotId, lotIds), eq(productAllocations.status, 'SOLD')));
      for (const o of sold) await this.outbox.publish('recall.notice', o.orderId, { orderId: o.orderId, number: o.number, userId: o.userId, title, message: input.reason }, tx);
      const openOrders = new Set(held.map((h) => h.orderId)).size;
      const [u] = await tx.update(productRecalls).set({ lotsAffected: lots.length, unitsOnHand: lots.reduce((a, l) => a + l.lot.onHand, 0), ordersAffected: openOrders + sold.length, customersNotified: sold.length }).where(eq(productRecalls.id, rec.id)).returning();
      await this.audit.log({ organizationId: input.organizationId, actorId: user.sub, action: 'packaged.recall', entityType: 'product_recall', entityId: rec.id, after: u, reason: input.reason }, tx);
      return { ...u, openOrdersChanged: openOrders };
    });
    await this.invalidate([...new Set(lots.map((l) => l.lot.locationId))]);
    return result;
  }

  async recalls(user: JwtPayload, scope: { locationId?: string }) {
    if (scope.locationId) {
      const loc = await this.location(scope.locationId);
      assertOrgAccess(user, loc.organizationId, loc.id);
      return this.db.select().from(productRecalls).where(sql`${productRecalls.organizationId} = ${loc.organizationId} or (${productRecalls.organizationId} is null and exists (select 1 from product_lots l where l.id = any(${productRecalls.lotIds}) and l.location_id = ${loc.id}))`).orderBy(desc(productRecalls.createdAt)).limit(100);
    }
    assertCan(user, 'catalog.read');
    const rs = await this.db.select({ r: productRecalls, orgName: organizations.name }).from(productRecalls).leftJoin(organizations, eq(organizations.id, productRecalls.organizationId)).orderBy(desc(productRecalls.createdAt)).limit(200);
    return rs.map((x) => ({ ...x.r, organizationName: x.orgName }));
  }

  async closeRecall(user: JwtPayload, id: string, note: string) {
    const [r] = await this.db.select().from(productRecalls).where(eq(productRecalls.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    if (r.organizationId && !isPlatformStaff(user)) assertOrgAccess(user, r.organizationId, null, MANAGER_ROLES);
    else assertCan(user, 'catalog.manage');
    const [u] = await this.db.update(productRecalls).set({ status: 'CLOSED', closedAt: new Date(), closedNote: note }).where(eq(productRecalls.id, id)).returning();
    await this.audit.log({ organizationId: r.organizationId, actorId: user.sub, action: 'packaged.recall.close', entityType: 'product_recall', entityId: id, reason: note });
    return u;
  }

  // ───── staff: review, policy, overview ─────

  async adminProducts(user: JwtPayload, f: { status?: string; q?: string; orgId?: string }) {
    assertCan(user, 'catalog.read');
    const conds = [];
    if (f.status) conds.push(eq(packagedProducts.reviewStatus, f.status));
    if (f.orgId) conds.push(eq(packagedProducts.organizationId, f.orgId));
    if (f.q) conds.push(sql`(${menuItems.name} ilike ${`%${f.q}%`} or ${packagedProducts.gtin} like ${`%${f.q.replace(/\D/g, '') || '~'}%`} or ${packagedProducts.brandName} ilike ${`%${f.q}%`} or ${packagedProducts.sku} ilike ${`%${f.q}%`})`);
    const rs = await this.db.select({ p: packagedProducts, item: menuItems, orgName: organizations.name, orgKind: organizations.kind, locationId: menus.locationId, locationName: locations.name })
      .from(packagedProducts).innerJoin(menuItems, eq(menuItems.id, packagedProducts.menuItemId)).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId))
      .leftJoin(organizations, eq(organizations.id, packagedProducts.organizationId)).leftJoin(locations, eq(locations.id, menus.locationId))
      .where(conds.length ? and(...conds) : undefined).orderBy(sql`case ${packagedProducts.reviewStatus} when 'PENDING' then 0 else 1 end`, desc(packagedProducts.submittedAt)).limit(300);
    const ids = rs.map((x) => x.p.menuItemId);
    const stock = ids.length ? rows<{ menu_item_id: string; on_hand: number; lots: number }>(await this.db.execute(sql`select menu_item_id, sum(on_hand)::int as on_hand, count(*)::int as lots from product_lots where menu_item_id = any(${`{${ids.join(',')}}`}::uuid[]) and status in ('ACTIVE','EXPIRED','QUARANTINED') group by 1`)) : [];
    return rs.map((x) => ({
      ...x.p, name: x.item.name, description: x.item.description, priceCents: x.item.priceCents, imageUrl: x.item.imageUrl, allergens: x.item.allergens, taxCategory: x.item.taxCategory,
      size: sizeLabel(x.p.size, x.p.sizeUom, x.p.unitCount), organizationName: x.orgName, firstParty: x.orgKind === 'PLATFORM', locationId: x.locationId, locationName: x.locationName,
      onHand: stock.find((s) => s.menu_item_id === x.p.menuItemId)?.on_hand ?? 0, lots: stock.find((s) => s.menu_item_id === x.p.menuItemId)?.lots ?? 0,
    }));
  }

  async review(user: JwtPayload, itemId: string, decision: 'APPROVE' | 'REJECT' | 'SUSPEND', note: string) {
    assertCan(user, 'catalog.manage');
    const r = await this.itemWithMenu(itemId);
    if (!r.product) throw new NotFoundException('Not a packaged product');
    const allowedFrom: Record<string, string[]> = { APPROVE: ['PENDING', 'REJECTED', 'SUSPENDED', 'DRAFT'], REJECT: ['PENDING', 'DRAFT'], SUSPEND: ['APPROVED', 'PENDING'] };
    if (!allowedFrom[decision].includes(r.product.reviewStatus)) throw new ConflictException({ message: `Can't ${decision.toLowerCase()} a product that is ${r.product.reviewStatus.toLowerCase()}`, code: 'PACKAGED_REVIEW_STATE' });
    const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'SUSPENDED';
    const [u] = await this.db.update(packagedProducts).set({ reviewStatus: status, reviewNote: note, reviewedAt: new Date(), reviewedById: user.sub }).where(eq(packagedProducts.menuItemId, itemId)).returning();
    await this.audit.log({ organizationId: r.product.organizationId, actorId: user.sub, action: `packaged.review.${decision.toLowerCase()}`, entityType: 'menu_item', entityId: itemId, before: { reviewStatus: r.product.reviewStatus }, after: { reviewStatus: status }, reason: note });
    await this.invalidate(await this.locationsForMenu(r.menu.id, r.menu.locationId));
    return u;
  }

  async getPolicy(user: JwtPayload) {
    assertCan(user, 'catalog.read');
    const [row] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, 'fees.packaged')).limit(1);
    return { policy: await this.stock.policy(), commission: (row?.value as { commissionBps: number | null } | undefined) ?? { commissionBps: null } };
  }

  async savePolicy(user: JwtPayload, policy: Partial<PackagedGoodsPolicy>, reason: string) {
    assertCan(user, 'catalog.manage');
    const before = await this.stock.policy();
    const after = { ...before, ...policy, categories: { ...before.categories, ...(policy.categories || {}) }, minRemainingDays: { ...before.minRemainingDays, ...(policy.minRemainingDays || {}) }, nearExpiryDays: { ...before.nearExpiryDays, ...(policy.nearExpiryDays || {}) } };
    await this.db.insert(platformSettings).values({ key: 'catalog.packaged', value: after as never }).onConflictDoUpdate({ target: platformSettings.key, set: { value: after as never } });
    await this.audit.configChange({ key: 'catalog.packaged', before, after, actorId: user.sub, approvedById: user.sub });
    await this.audit.log({ actorId: user.sub, action: 'packaged.policy', entityType: 'setting', entityId: 'catalog.packaged', before, after, reason });
    await this.redis.del('setting:catalog.packaged');
    // every location page caches its menu briefly; a policy change shows within that window (30 s)
    return this.stock.policy();
  }

  async overview(user: JwtPayload) {
    assertCan(user, 'catalog.read');
    const [counts, stock, expiring, recalls, sales] = await Promise.all([
      this.db.execute(sql`select review_status, count(*)::int as n from packaged_products group by 1`),
      this.db.execute(sql`select count(*)::int as lots, coalesce(sum(on_hand),0)::int as units, coalesce(sum(reserved),0)::int as reserved, coalesce(sum(on_hand * unit_cost_cents),0)::bigint as value_cents from product_lots where status = 'ACTIVE'`),
      this.db.execute(sql`select count(*)::int as lots, coalesce(sum(on_hand - reserved),0)::int as units from product_lots where status = 'ACTIVE' and expires_on is not null and expires_on <= current_date + 7`),
      this.db.execute(sql`select count(*)::int as n from product_recalls where status = 'OPEN'`),
      this.db.execute(sql`select p.category, sum(a.quantity)::int as units, sum(round(ol.unit_price_cents::numeric * a.quantity))::bigint as revenue_cents, count(distinct a.order_id)::int as orders,
        sum(case when org.kind = 'PLATFORM' then a.quantity else 0 end)::int as first_party_units
        from product_allocations a join packaged_products p on p.menu_item_id = a.menu_item_id join order_lines ol on ol.id = a.order_line_id join organizations org on org.id = p.organization_id
        where a.status = 'SOLD' and a.settled_at >= now() - interval '30 days' group by 1 order by 2 desc`),
    ]);
    const waste = rows<{ kind: string; units: number }>(await this.db.execute(sql`select kind, -sum(quantity)::int as units from product_stock_movements where kind in ('WASTE','SHORT_PICK') and created_at >= now() - interval '30 days' group by 1`));
    return {
      review: Object.fromEntries(rows<{ review_status: string; n: number }>(counts).map((x) => [x.review_status, x.n])),
      stock: rows(stock)[0], expiringIn7Days: rows(expiring)[0], openRecalls: (rows<{ n: number }>(recalls)[0]?.n) ?? 0,
      sales30d: rows(sales), waste30d: waste, policy: await this.stock.policy(),
    };
  }

  /** Hourly: batches past their sell-by point stop selling and show as "to remove" for the store. */
  async expirySweep() {
    const p = await this.stock.policy();
    const r = rows<{ id: string; menu_item_id: string; location_id: string; on_hand: number; reserved: number }>(await this.db.execute(sql`update product_lots l set status = 'EXPIRED', updated_at = now()
      from packaged_products p, locations loc
      where p.menu_item_id = l.menu_item_id and loc.id = l.location_id and l.status = 'ACTIVE' and l.expires_on is not null and p.date_type <> 'NONE'
        and l.expires_on < (timezone(loc.timezone, now()))::date + (coalesce(p.min_remaining_days, case p.storage when 'CHILLED' then ${p.minRemainingDays.CHILLED}::int when 'FROZEN' then ${p.minRemainingDays.FROZEN}::int else ${p.minRemainingDays.AMBIENT}::int end) + case when p.date_type = 'USE_BY' then 1 else 0 end)
      returning l.id, l.menu_item_id, l.location_id, l.on_hand, l.reserved`));
    for (const l of r) await this.db.insert(productStockMovements).values({ lotId: l.id, menuItemId: l.menu_item_id, locationId: l.location_id, kind: 'EXPIRED', quantity: 0, reason: `Past its sell-by point: ${l.on_hand - l.reserved} unit(s) to remove from the shelf` });
    if (r.length) await this.invalidate([...new Set(r.map((x) => x.location_id))]);
    return { expired: r.length };
  }

  async staffSweep(user: JwtPayload) {
    assertCan(user, 'catalog.manage');
    return this.expirySweep();
  }

  /** Staff view of one product: batches everywhere and recent movements. */
  async adminProduct(user: JwtPayload, itemId: string) {
    assertCan(user, 'catalog.read');
    const r = await this.itemWithMenu(itemId);
    if (!r.product) throw new NotFoundException('Not a packaged product');
    const lots = await this.db.select({ l: productLots, locationName: locations.name }).from(productLots).innerJoin(locations, eq(locations.id, productLots.locationId)).where(eq(productLots.menuItemId, itemId)).orderBy(desc(productLots.receivedAt)).limit(100);
    const moves = await this.db.select().from(productStockMovements).where(eq(productStockMovements.menuItemId, itemId)).orderBy(desc(productStockMovements.createdAt)).limit(100);
    return { item: r.item, product: r.product, size: sizeLabel(r.product.size, r.product.sizeUom, r.product.unitCount), lots: lots.map((x) => ({ ...x.l, locationName: x.locationName })), movements: moves };
  }
}
