import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { packagedPolicy, sellerAllowed, sizeLabel, type PackagedCategory, type PackagedDateType, type PackagedFacts, type PackagedGoodsPolicy, type PackagedStorage } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../db/db.module';
import { packagedProducts, productAllocations, productLots, productStockMovements } from '../db/schema';
import { SettingsService } from './settings.service';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;

export interface PackagedState {
  /** false = sold out for a reason other than stock (policy off, not approved, category or seller blocked) */
  sellable: boolean;
  reason: string | null;
  available: number;
  maxPerOrder: number;
  facts: PackagedFacts;
  product: typeof packagedProducts.$inferSelect;
}

/**
 * Packaged goods stock: what can be sold at a location right now, and first-expiry-first reservation at checkout.
 * Releasing and selling reserved units is done by database triggers on orders and order lines (migration 0032),
 * so every way an order ends keeps stock right.
 */
@Injectable()
export class PackagedStockService {
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService) {}

  async policy(): Promise<PackagedGoodsPolicy> {
    return packagedPolicy(await this.settings.get<Partial<PackagedGoodsPolicy> | null>('catalog.packaged', null));
  }

  /** Days a batch must still have before its date to be sold (USE_BY adds a day: never sold on its date). */
  minDays(p: PackagedGoodsPolicy, prod: { storage: string; minRemainingDays: number | null; dateType: string }) {
    if (prod.dateType === 'NONE') return null;
    return prod.minRemainingDays ?? p.minRemainingDays[prod.storage as PackagedStorage] ?? 0;
  }

  /** SQL condition: batch `l` (joined with product `p` and location `loc`) can be sold for fulfilment at `at`. */
  private sellableSql(p: PackagedGoodsPolicy, at: Date) {
    return sql`l.status = 'ACTIVE' and l.on_hand > l.reserved and (p.date_type = 'NONE' or l.expires_on is null or l.expires_on >= (timezone(loc.timezone, ${at.toISOString()}::timestamptz))::date
      + (coalesce(p.min_remaining_days, case p.storage when 'CHILLED' then ${p.minRemainingDays.CHILLED}::int when 'FROZEN' then ${p.minRemainingDays.FROZEN}::int else ${p.minRemainingDays.AMBIENT}::int end)
      + case when p.date_type = 'USE_BY' then 1 else 0 end))`;
  }

  /** Available units per product at a location for fulfilment at `at`. */
  async available(locationId: string, itemIds: string[], at = new Date(), tx: DbOrTx = this.db, policy?: PackagedGoodsPolicy): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!itemIds.length) return out;
    const p = policy || (await this.policy());
    const r = rows<{ menu_item_id: string; n: number }>(await tx.execute(sql`select l.menu_item_id, sum(l.on_hand - l.reserved)::int as n from product_lots l
      join packaged_products p on p.menu_item_id = l.menu_item_id join locations loc on loc.id = l.location_id
      where l.location_id = ${locationId} and l.menu_item_id = any(${`{${itemIds.join(',')}}`}::uuid[]) and ${this.sellableSql(p, at)} group by 1`));
    for (const x of r) out.set(x.menu_item_id, Number(x.n) || 0);
    return out;
  }

  /** Whether the product can be offered at all (policy, review, category, seller), independent of stock. */
  gate(p: PackagedGoodsPolicy, prod: typeof packagedProducts.$inferSelect): string | null {
    if (!p.enabled) return 'Packaged goods are not available right now';
    if (!p.categories[prod.category as PackagedCategory]?.allowed) return 'This kind of product cannot be sold on Gutad right now';
    if (!sellerAllowed(p, prod.organizationId)) return 'This store cannot sell packaged goods right now';
    if (prod.reviewStatus !== 'APPROVED') return prod.reviewStatus === 'SUSPENDED' ? 'Suspended by Gutad' : 'Waiting for Gutad review';
    return null;
  }

  /** Product state for the packaged items among `itemIds` at a location (items without a product record are skipped). */
  async stateFor(locationId: string, itemIds: string[], at = new Date(), tx: DbOrTx = this.db): Promise<Map<string, PackagedState>> {
    const out = new Map<string, PackagedState>();
    if (!itemIds.length) return out;
    const prods = await tx.select().from(packagedProducts).where(inArray(packagedProducts.menuItemId, itemIds));
    if (!prods.length) return out;
    const p = await this.policy();
    const avail = await this.available(locationId, prods.map((x) => x.menuItemId), at, tx, p);
    for (const prod of prods) {
      const reason = this.gate(p, prod);
      const available = reason ? 0 : avail.get(prod.menuItemId) ?? 0;
      out.set(prod.menuItemId, {
        sellable: !reason,
        reason,
        available,
        maxPerOrder: p.maxPerOrder,
        product: prod,
        facts: {
          brandName: prod.brandName,
          size: sizeLabel(prod.size, prod.sizeUom, prod.unitCount),
          category: prod.category as PackagedCategory,
          storage: prod.storage as PackagedStorage,
          dateType: prod.dateType as PackagedDateType,
          minShelfLifeDays: this.minDays(p, prod),
          ingredients: prod.ingredientsText,
          countryOfOrigin: prod.countryOfOrigin,
          labelImageUrl: prod.labelImageUrl,
          onlyLeft: available > 0 && p.showStockBelow > 0 && available <= p.showStockBelow ? available : null,
        },
      });
    }
    return out;
  }

  /**
   * Holds stock for an order's packaged lines, first expiry first, inside the order's transaction.
   * Batches are row-locked, so two checkouts never take the same unit. Not enough stock → OUT_OF_STOCK (the order rolls back).
   */
  async reserve(tx: DbOrTx, input: { orderId: string; orderNumber: string; locationId: string; at: Date; lines: { orderLineId: string; menuItemId: string | null; quantity: number; name: string }[] }) {
    const ids = [...new Set(input.lines.map((l) => l.menuItemId).filter((x): x is string => !!x))];
    if (!ids.length) return 0;
    const prods = await tx.select().from(packagedProducts).where(inArray(packagedProducts.menuItemId, ids));
    if (!prods.length) return 0;
    const p = await this.policy();
    let held = 0;
    for (const l of input.lines) {
      const prod = prods.find((x) => x.menuItemId === l.menuItemId);
      if (!prod) continue;
      const gate = this.gate(p, prod);
      if (gate) throw new BadRequestException({ message: `${l.name}: ${gate}`, code: 'OUT_OF_STOCK', menuItemId: prod.menuItemId, available: 0 });
      const lots = rows<{ id: string; free: number }>(await tx.execute(sql`select l.id, (l.on_hand - l.reserved)::int as free from product_lots l
        join packaged_products p on p.menu_item_id = l.menu_item_id join locations loc on loc.id = l.location_id
        where l.location_id = ${input.locationId} and l.menu_item_id = ${prod.menuItemId} and ${this.sellableSql(p, input.at)}
        order by l.expires_on asc nulls last, l.received_at asc for update of l`));
      let need = l.quantity;
      const take: { lotId: string; q: number }[] = [];
      for (const lot of lots) {
        if (need <= 0) break;
        const q = Math.min(need, Number(lot.free));
        if (q > 0) { take.push({ lotId: lot.id, q }); need -= q; }
      }
      if (need > 0) {
        const available = lots.reduce((a, x) => a + Number(x.free), 0);
        throw new BadRequestException({ message: available ? `${l.name}: only ${available} left` : `${l.name} is sold out`, code: 'OUT_OF_STOCK', menuItemId: prod.menuItemId, available });
      }
      for (const t of take) {
        await tx.update(productLots).set({ reserved: sql`${productLots.reserved} + ${t.q}` }).where(eq(productLots.id, t.lotId));
        await tx.insert(productAllocations).values({ orderId: input.orderId, orderLineId: l.orderLineId, lotId: t.lotId, menuItemId: prod.menuItemId, locationId: input.locationId, quantity: t.q });
        await tx.insert(productStockMovements).values({ lotId: t.lotId, menuItemId: prod.menuItemId, locationId: input.locationId, kind: 'RESERVE', quantity: -t.q, orderId: input.orderId, reason: `Order ${input.orderNumber}` });
        held += t.q;
      }
    }
    return held;
  }

  /** Batches an order line takes (for pick lists and receipts). */
  async allocationsFor(orderId: string, tx: DbOrTx = this.db) {
    return tx.select({ orderLineId: productAllocations.orderLineId, quantity: productAllocations.quantity, status: productAllocations.status, lotCode: productLots.lotCode, expiresOn: productLots.expiresOn, unitCostCents: productLots.unitCostCents })
      .from(productAllocations).innerJoin(productLots, eq(productLots.id, productAllocations.lotId)).where(eq(productAllocations.orderId, orderId));
  }
}
