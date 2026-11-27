# Packaged goods: Release 1

Started 2026-11-27. Merchants, and Gutad itself (org kind `PLATFORM`, see first-party selling 5150c8b), can sell packaged,
shelf-stable goods next to the cooked food they already sell. Examples are jarred sauces, snacks, drinks, frozen dumplings and bottled house
dressings. Everything runs through the same menu, cart, checkout, kitchen screen, delivery and payout. The controls are in Admin and in
the merchant portal.

## What the code had before
- A menu item is either sold out or not. Only ingredient stock-outs sell items out automatically. Sold items have no count.
- `shelfLifeDays`, storage temperatures, lots and recalls exist only for back-of-house ingredients (`stock_lots`, `recalls`).
- There is no SKU or barcode on a sale item, and nothing records which batch went to which customer.
- Every line goes to a cooking station with a cook time.
- Tax already has a `GROCERY` category (TaxJar 40030, Avalara PF050001).

## How other platforms do it (research 2026-11-27)
| Topic | What they do | What Gutad takes from it |
|---|---|---|
| Identifiers | DoorDash's retail catalog needs a UPC/GTIN/PLU plus the merchant's own item id. Instacart keeps the UPC with its check digit. | Separate `sku` (the merchant's own) and optional `gtin`, normalised to 14 digits and check-digit validated. |
| Size | Instacart: `size` + `size_uom` + `unit_count` (12 fl oz × 8). | The same three fields, with a fixed unit list. |
| Weighted items | Instacart/DoorDash/Uber charge the final weight at pick time. | Not in R1: packaged goods are fixed-quantity "each" items. |
| Inventory states | Shopify: on hand = available + committed + unavailable. Committed at order, taken off at fulfilment, released on cancel. | `on_hand` and `reserved` per batch: available = on_hand − reserved for sellable batches. |
| Auto sold-out | DoorDash Locally sets an item inactive at 0. Square has per-location low-stock thresholds and a digest. | Sold out at 0 is computed, never a stale flag. A low-stock threshold per product feeds the merchant dashboard. |
| Expiry | Amazon FBA: lot-controlled, expiry on the unit, removed when ≤ 50 days are left. USDA: "Use-By" is the safety date, "Best if Used By" is quality. | Batches (lots) with a date and date type. Each product sells only while at least *N* days remain (set per storage type in the policy). A USE_BY batch is never sold on or after its date. |
| FEFO / traceability | Lot-tracking apps (Lotegrity, LotTrack) allocate first-expiry-first and recall by lot. FSMA 204 needs lot codes (due 2028-07-20). | First-expiry-first allocation at checkout. Each order line records the batches it took, so a recall reaches the customers who got that batch. |
| New-product review | DoorDash reviews new retail SKUs, and Amazon gates the Grocery category. | Admin review queue (optional per category, on by default). |
| Restricted items | Alcohol needs a licence on file and an ID check at the door. | Category `ALCOHOL` is off by default. When on, tax category ALCOHOL triggers the Courier R4 age-check handoff. |
| Out of stock at pick | Uber/DoorDash/Instacart: substitute or refund per line, with customer approval. | Uses the existing "item unavailable" flow (replace or credit). The missing units are written off so they don't oversell again. |
| Cottage food | State rules differ (CT bans delivery apps, AZ bans dairy/meat, MI allows with contact). | Category `HOUSE_MADE` is reviewed by default. A licence-type check per state is R2. |
| Chilled / frozen | FBA bans them. | Local delivery only (no shipping in R1). They add the `COLD` handling flag, so packing uses a cold bag. |
| Tax | Prepared vs grocery rules differ by state (the WA 75% rule). | Tax category per product (default from the category, e.g. GROCERY). The existing tax engine resolves the rate. |
| 1P vs 3P fairness | Amazon's EU commitments: no use of seller data, neutral ranking, same rules. | Gutad's own products follow the same review, policy and ranking as merchants. The `reviewFirstParty` setting defaults to on. |

## What Release 1 adds

| Area | Addition |
|---|---|
| Catalog | Menu item `kind = 'PACKAGED'` plus a `packaged_products` row (1:1): `sku`, `gtin`, `brandName`, `size`, `sizeUom`, `unitCount`, `category`, `storage` (AMBIENT/CHILLED/FROZEN), `dateType` (BEST_BEFORE/USE_BY/NONE), `minRemainingDays` (null = policy), `ingredientsText`, `countryOfOrigin`, `labelImageUrl`, `lowStockThreshold`, and review fields. Allergens, nutrition, photos, price and tax category stay on the menu item. A packaged product sits in a normal menu category, so one cart can mix cooked and packaged items. Not allowed at Chef Network kitchens. |
| Review | `reviewStatus` DRAFT → PENDING → APPROVED / REJECTED, and SUSPENDED (staff pulled it). A product is sellable only when APPROVED, or when review is off for its category. Changes to label fields (name, GTIN, ingredients, allergens, category, storage, date type) send an approved product back to PENDING when the policy requires review. The price does not. |
| Stock | `product_lots` per (product, location): `lotCode`, `expiresOn`, `onHand`, `reserved`, `unitCostCents`, `status` (ACTIVE / EXPIRED / RECALLED / QUARANTINED / DEPLETED). `product_stock_movements` is the ledger (RECEIPT, RESERVE, RELEASE, SALE, ADJUSTMENT, COUNT, WASTE, EXPIRED, RECALL, SHORT_PICK, RETURN). |
| Sellable | A batch is sellable when it is ACTIVE, `onHand > reserved`, and its date is ≥ the fulfilment date + min remaining days (+1 day for USE_BY). Available = Σ(onHand − reserved) over sellable batches. Sold out = not approved, policy off, seller blocked, or available ≤ 0. |
| Checkout | Quote: a packaged line needs quantity ≤ available (409 `OUT_OF_STOCK` `{ available }`). Order placement: inside the order transaction the batches are locked and allocated first-expiry-first into `product_allocations` (RESERVED). If stock ran out since the quote, the whole order rolls back with `OUT_OF_STOCK`. |
| Release / sell | Database triggers keep this right however an order ends. Order → CANCELED/REJECTED releases RESERVED units (RELEASE). Order → COLLECTED/COMPLETED/PARTIALLY_FULFILLED takes them off the shelf (SALE: `onHand` and `reserved` both drop). Line → UNAVAILABLE writes the units off as SHORT_PICK, because they weren't there. Line → CREDITED/REPLACED before that releases them. Units already sold are never put back automatically; the store uses "Return to stock". |
| Kitchen | Packaged lines go to a `PICK` station with a 2-minute ticket, with the batch and date to pick. The packing checklist gains "Best-before dates checked". Chilled and frozen products add the `COLD` flag (cold bag, courier COLD_BAG preference). |
| Expiry | Hourly job. A batch past its sell-by point becomes EXPIRED (stock stays on the batch until the store records disposal as WASTE). Products within the near-expiry window show on the merchant's "Expiring soon" list. |
| Recalls | A merchant recalls its own batches, products or GTIN. Gutad staff recall by GTIN across every seller (e.g. a manufacturer recall), or by product or batch. Matching ACTIVE batches become RECALLED. Every order that received units from them is listed, and its customer gets the existing `recall.notice` message. |
| Money | Setting `fees.packaged` `{ commissionBps: number | null }`: commission on packaged lines (null = the store's normal rate). It goes through Approvals like every `fees.*` key. Gutad's own sales stay at 0 commission. For Gutad's own stores, cost of goods comes from the batch unit cost (PLATFORM_EXPENSE_COGS / INVENTORY). |
| Customer | The menu item carries `packaged` facts: size, brand, storage, ingredients, origin, and the promise "at least N days before its best-before date". It shows "Only N left" at or below the policy's `showStockBelow`, and is sold out at 0. |

## Policy (`@gutad/shared` `PackagedGoodsPolicy`, setting `catalog.packaged`)
```ts
{
  enabled: true,                       // kill switch: off = every packaged product is sold out and checkout refuses them
  requireReview: true,                 // new products (and label changes) need staff approval
  reviewFirstParty: true,              // Gutad's own products go through the same review
  categories: { PANTRY, SNACKS, BEVERAGES, SAUCES, BAKERY, CHILLED, FROZEN, HOUSE_MADE, ALCOHOL, OTHER }
              → { allowed, review, taxCategory }   // ALCOHOL allowed:false, tax ALCOHOL; BEVERAGES tax BEVERAGE; others GROCERY
  minRemainingDays: { AMBIENT: 30, CHILLED: 2, FROZEN: 14 },
  nearExpiryDays:   { AMBIENT: 45, CHILLED: 3, FROZEN: 30 },
  requireGtin: false,                  // house-made goods have no barcode
  requireLabelImage: false,
  showStockBelow: 5,
  maxPerOrder: 20,
  sellers: 'ALL' | 'ALLOW_LIST', allowOrgIds: [], blockedOrgIds: [],
}
```

## API (`M` merchant with location access, managers to change; `A` staff: `catalog.read` view, `catalog.manage` change)

### Merchant
- `GET /locations/:id/packaged` → `{ policy summary, products: { itemId, name, priceCents, reviewStatus, storage, category, sku, gtin, available, onHand, reserved, lowStock, nextExpiry, lots[] }[], expiringSoon[], lowStock[] }`
- `POST /categories/:id/packaged` (create the item and product) · `PATCH /packaged/:itemId` · `POST /packaged/:itemId/submit`
- `POST /packaged/:itemId/lots { locationId, quantity, lotCode?, expiresOn?, unitCostCents?, supplierName? }` (receive)
- `POST /packaged-lots/:lotId/adjust { kind: COUNT|ADJUSTMENT|WASTE|RETURN, quantity, reason }`
- `GET /packaged/:itemId/movements?locationId=`
- `POST /locations/:id/packaged/recalls { scope: LOT|PRODUCT|GTIN, lotIds?, itemId?, gtin?, reason }`
- `GET /locations/:id/packaged/recalls`

### Admin
- `GET /admin/packaged` → overview (counts, review queue size, expiring, open recalls, sales by category)
- `GET /admin/packaged/products?status=&q=&orgId=` · `POST /admin/packaged/:itemId/review { decision: APPROVE|REJECT|SUSPEND, note }`
- `GET /admin/packaged/policy` · `PUT /admin/packaged/policy { policy, reason }` (audited config change)
- `POST /admin/packaged/recalls { scope, gtin?, itemId?, lotIds?, reason, severity }` · `GET /admin/packaged/recalls` · `POST /admin/packaged/recalls/:id/close { note }`
- `POST /admin/packaged/sweep` (runs the hourly expiry job)

## Screens
- **Web merchant**: Products (`/merchant/products`) has tabs for products, stock and batches, expiring soon, recalls, and movements. The Menu page shows a "Packaged" badge.
- **Web admin**: Packaged goods (`/admin/packaged`) has tabs for overview, review queue, products, recalls and policy (plus the commission setting).
- **Web customer**: product facts in the item dialog, "Only N left", and storage badges.
- **Mobile merchant**: Products screen (stock, receive, count/waste, expiring). **Mobile ops**: packaged review queue. **Mobile customer**: product facts on the location page.

## Later (R2)
Variable-weight items, per-line substitution choice at checkout, a CSV/POS stock feed, near-expiry markdowns, seller licence types per state
(cottage / commercial / manufacturer), shipping ambient goods, low-stock email digests, and variants (one product in several sizes).
