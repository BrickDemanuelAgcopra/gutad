/**
 * Idempotent seed: platform admin from env, membership plans, and (unless SEED_DEMO=false) a demo city
 * with a verified live restaurant, a shared kitchen with two virtual brands, a customer and a driver.
 * Run: npm run db:seed (after migrate). Safe to re-run.
 */
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createDb, createPool } from './db.module';
import * as s from './schema';
import { loadConfig } from '../config/config';

async function main() {
  const cfg = loadConfig();
  const pool = createPool();
  const db = createDb(pool);
  const log = (m: string) => console.log(`[seed] ${m}`); // eslint-disable-line no-console

  // platform admin
  const adminEmail = cfg.ADMIN_EMAIL.toLowerCase();
  let [admin] = await db.select().from(s.users).where(eq(s.users.email, adminEmail)).limit(1);
  if (!admin) {
    [admin] = await db.insert(s.users).values({ email: adminEmail, passwordHash: await argon2.hash(cfg.ADMIN_PASSWORD), name: 'Platform Admin', roles: ['PLATFORM_ADMIN', 'SUPPORT', 'FINANCE'], emailVerifiedAt: new Date() }).returning();
    log(`created admin ${adminEmail}`);
  }

  // membership plans
  const [plan] = await db.select().from(s.membershipPlans).limit(1);
  if (!plan) {
    await db.insert(s.membershipPlans).values([
      { name: 'Gutad+', priceCents: 799, interval: 'MONTH', benefits: { freeDeliveryAboveCents: 1500, priorityWaitlist: true, serviceFeeWaived: true, creditCentsPerMonth: 0 } },
      { name: 'Gutad+ Annual', priceCents: 7900, interval: 'YEAR', benefits: { freeDeliveryAboveCents: 1500, priorityWaitlist: true, serviceFeeWaived: true, creditCentsPerMonth: 200 } },
    ]);
    log('created membership plans');
  }

  await db.insert(s.platformSettings).values([
    { key: 'fees.marketplace_service_fee_bps', value: 500 },
    { key: 'fees.marketplace_service_fee_cap_cents', value: 400 },
    { key: 'fees.free_delivery', value: true },
    { key: 'support.auto_reject_minutes', value: 20 },
  ]).onConflictDoNothing();

  if (process.env.SEED_DEMO === 'false') {
    await pool.end();
    return;
  }

  // demo merchant
  const [existingOrg] = await db.select().from(s.organizations).where(eq(s.organizations.slug, 'demo-bistro')).limit(1);
  if (existingOrg) {
    log('demo data already present');
    await pool.end();
    return;
  }
  const ownerPw = await argon2.hash('merchant12345');
  const [owner] = await db.insert(s.users).values({ email: 'owner@demo.gutad.io', passwordHash: ownerPw, name: 'Dana Owner', roles: ['CUSTOMER'], emailVerifiedAt: new Date() }).returning();
  const [host] = await db.insert(s.users).values({ email: 'host@demo.gutad.io', passwordHash: ownerPw, name: 'Hal Host', roles: ['CUSTOMER'] }).returning();
  const [customer] = await db.insert(s.users).values({ email: 'customer@demo.gutad.io', passwordHash: await argon2.hash('customer12345'), name: 'Casey Customer', phone: '+15550100', roles: ['CUSTOMER'], marketingConsent: true, emailVerifiedAt: new Date() }).returning();
  const [driverUser] = await db.insert(s.users).values({ email: 'driver@demo.gutad.io', passwordHash: await argon2.hash('driver12345'), name: 'Drew Driver', roles: ['CUSTOMER', 'DRIVER'] }).returning();
  await db.insert(s.drivers).values({ userId: driverUser.id, status: 'APPROVED', vehicle: 'Bike', licenseVerified: true, isAvailable: true, lastLat: 40.7306, lastLng: -73.9866, lastSeenAt: new Date(), payoutAccountId: 'mock_acct_driver' });

  const [org] = await db.insert(s.organizations).values({ name: 'Demo Bistro Group', slug: 'demo-bistro', kind: 'MERCHANT', billingEmail: owner.email, status: 'LIVE', featureFlags: { ordering: true, reservations: true, delivery: true, events: true, sharedKitchen: true, programs: true } }).returning();
  await db.insert(s.orgMemberships).values([
    { userId: owner.id, organizationId: org.id, role: 'MERCHANT_OWNER', acceptedAt: new Date(), approvalLimitCents: 10_000 },
    { userId: host.id, organizationId: org.id, role: 'HOST', acceptedAt: new Date() },
  ]);
  const [seller] = await db.insert(s.legalSellers).values({ organizationId: org.id, legalName: 'Demo Bistro LLC', country: 'US', payoutProvider: 'mock', payoutAccountId: 'mock_acct_demo', payoutOnboardingState: 'COMPLETE', bankLast4: '4242', beneficiaryName: 'Demo Bistro LLC' }).returning();

  const [loc] = await db.insert(s.locations).values({
    organizationId: org.id, legalSellerId: seller.id, name: 'Demo Bistro', slug: 'demo-bistro-new-york', description: 'Neighborhood bistro: seasonal plates, natural wine, Sunday brunch.', cuisine: ['american', 'bistro', 'brunch'],
    phone: '+12125550100', email: 'hello@demo.gutad.io', addressLine1: '12 E 12th St', city: 'New York', region: 'NY', postalCode: '10003', lat: 40.7339, lng: -73.9921, timezone: 'America/New_York',
    heroImageUrl: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200', photos: ['https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=1200'], amenities: ['outdoor seating', 'wheelchair accessible', 'full bar'],
    status: 'LIVE', verifiedAt: new Date(), claimedByUserId: owner.id, acceptsPickup: true, acceptsDelivery: true, acceptsDineIn: true, acceptsReservations: true, acceptsEvents: true, acceptsCatering: true, defaultPrepMinutes: 20, taxRateBps: 888, deliveryFleet: 'PARTNER', deliveryRadiusKm: 6, deliveryBaseFeeCents: 299, deliveryPerKmCents: 50, rating: 4.6, ratingCount: 128, tabletFallbackPhone: '+12125550100',
  }).returning();
  await db.insert(s.reservationPolicies).values({ locationId: loc.id, cancellationHours: 2, requiresCardAbove: 6, noShowFeeCents: 2500, depositCents: 0, holdMinutes: 10, largePartyThreshold: 8 });
  await db.insert(s.openingHours).values([0, 1, 2, 3, 4, 5, 6].map((d) => ({ locationId: loc.id, dayOfWeek: d, opens: '00:00', closes: '23:59', service: 'ALL' })));
  await db.insert(s.publications).values([
    { locationId: loc.id, kind: 'LISTING', channel: 'MARKETPLACE', slug: 'l-demo-bistro' },
    { locationId: loc.id, kind: 'ORDER_LINK', channel: 'DIRECT', slug: 'order-demo-bistro' },
    { locationId: loc.id, kind: 'BOOKING_WIDGET', channel: 'WIDGET', slug: 'book-demo-bistro' },
    { locationId: loc.id, kind: 'QR', channel: 'QR', slug: 'qr-demo-bistro' },
    { locationId: loc.id, kind: 'PARTNER_LINK', channel: 'PARTNER', slug: 'partner-demo-bistro', partnerName: 'Partner Delivery Co', partnerUrl: 'https://partner.example.com/demo-bistro' },
  ]);
  await db.insert(s.deliveryZones).values({ locationId: loc.id, name: 'Downtown', polygon: { type: 'Polygon', coordinates: [[[-74.02, 40.70], [-73.96, 40.70], [-73.96, 40.76], [-74.02, 40.76], [-74.02, 40.70]]] }, feeCents: 349, minOrderCents: 1500, etaMinutes: 35 });

  // contract
  const [contract] = await db.insert(s.merchantContracts).values({ organizationId: org.id, name: 'Full suite', planCode: 'FULL_SUITE', billingModels: ['SUBSCRIPTION', 'COMMISSION', 'PER_COVER', 'PREPAID_SERVICE_FEE', 'ADS'], subscriptionCents: 49900, marketplaceCommissionBps: 1500, directCommissionBps: 0, coverFeeNetworkCents: 100, coverFeeDirectCents: 0, prepaidServiceFeeBps: 200, signedAt: new Date() }).returning();
  await db.insert(s.contractLocations).values({ contractId: contract.id, locationId: loc.id, entitlements: { ordering: true, reservations: true, delivery: true, events: true } });
  await db.insert(s.platformSubscriptions).values({ organizationId: org.id, contractId: contract.id, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), locationCount: 1 });

  // menu
  const [menu] = await db.insert(s.menus).values({ organizationId: org.id, locationId: loc.id, name: 'All day' }).returning();
  const [starters] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Starters', sortOrder: 0 }).returning();
  const [mains] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Mains', sortOrder: 1 }).returning();
  const [drinks] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Drinks', sortOrder: 2 }).returning();
  const items = await db.insert(s.menuItems).values([
    { categoryId: starters.id, name: 'Burrata & peaches', description: 'Stracciatella, grilled peach, basil oil', priceCents: 1600, allergens: ['dairy'], stationCode: 'COLD', imageUrl: 'https://images.unsplash.com/photo-1505253716362-afaea1d3d1af?w=800' },
    { categoryId: starters.id, name: 'Crispy potatoes', description: 'Smoked paprika aioli', priceCents: 1100, dietaryTags: ['vegetarian'], stationCode: 'FRY' },
    { categoryId: mains.id, name: 'Bistro burger', description: 'Dry-aged beef, cheddar, pickles, fries', priceCents: 2200, allergens: ['gluten', 'dairy'], stationCode: 'GRILL', channelPrices: { MARKETPLACE: 2400 }, imageUrl: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800' },
    { categoryId: mains.id, name: 'Roast chicken', description: 'Half bird, jus, greens', priceCents: 2800, stationCode: 'GRILL' },
    { categoryId: mains.id, name: 'Mushroom risotto', description: 'Carnaroli, parmesan, thyme', priceCents: 2400, dietaryTags: ['vegetarian', 'gluten-free'], allergens: ['dairy'], stationCode: 'GRILL' },
    { categoryId: drinks.id, name: 'House lemonade', priceCents: 500, stationCode: 'COLD' },
  ]).returning();
  const burger = items.find((i) => i.name === 'Bistro burger')!;
  const [doneness] = await db.insert(s.modifierGroups).values({ name: 'Doneness', minSelect: 1, maxSelect: 1, required: true }).returning();
  await db.insert(s.modifierOptions).values([{ groupId: doneness.id, name: 'Medium rare' }, { groupId: doneness.id, name: 'Medium' }, { groupId: doneness.id, name: 'Well done' }]);
  const [extras] = await db.insert(s.modifierGroups).values({ name: 'Extras', minSelect: 0, maxSelect: 3 }).returning();
  await db.insert(s.modifierOptions).values([{ groupId: extras.id, name: 'Bacon', priceCents: 300 }, { groupId: extras.id, name: 'Fried egg', priceCents: 200 }, { groupId: extras.id, name: 'Avocado', priceCents: 250 }]);
  await db.insert(s.itemModifierGroups).values([{ itemId: burger.id, groupId: doneness.id, sortOrder: 0 }, { itemId: burger.id, groupId: extras.id, sortOrder: 1 }]);

  // floor & shifts
  const [mainRoom] = await db.insert(s.rooms).values({ locationId: loc.id, name: 'Main dining' }).returning();
  const [privRoom] = await db.insert(s.rooms).values({ locationId: loc.id, name: 'Back room', isPrivate: true }).returning();
  const tbls = await db.insert(s.tables).values([
    { locationId: loc.id, roomId: mainRoom.id, name: 'T1', section: 'Window', minSeats: 1, maxSeats: 2 },
    { locationId: loc.id, roomId: mainRoom.id, name: 'T2', section: 'Window', minSeats: 1, maxSeats: 2 },
    { locationId: loc.id, roomId: mainRoom.id, name: 'T3', section: 'Center', minSeats: 2, maxSeats: 4 },
    { locationId: loc.id, roomId: mainRoom.id, name: 'T4', section: 'Center', minSeats: 2, maxSeats: 4 },
    { locationId: loc.id, roomId: mainRoom.id, name: 'T5', section: 'Bar', minSeats: 1, maxSeats: 2 },
    { locationId: loc.id, roomId: privRoom.id, name: 'P1', section: 'Private', minSeats: 6, maxSeats: 12 },
  ]).returning();
  const [combo] = await db.insert(s.tableCombinations).values({ locationId: loc.id, name: 'T3+T4', minSeats: 5, maxSeats: 8 }).returning();
  await db.insert(s.tableComboMembers).values(tbls.filter((t) => ['T3', 'T4'].includes(t.name)).map((t) => ({ combinationId: combo.id, tableId: t.id })));
  await db.insert(s.shifts).values([
    { locationId: loc.id, name: 'Lunch', startTime: '11:30', endTime: '15:00', slotMinutes: 15, maxPartySize: 8, maxCoversPerSlot: 16, maxBookingsPerSlot: 5 },
    { locationId: loc.id, name: 'Dinner', startTime: '17:00', endTime: '22:30', slotMinutes: 15, maxPartySize: 8, maxCoversPerSlot: 20, maxBookingsPerSlot: 6 },
  ]);

  // experience
  const [exp] = await db.insert(s.experiences).values({ locationId: loc.id, name: 'Natural wine tasting', description: 'Five pours with the sommelier and snacks.', pricingMode: 'PREPAID_PER_PERSON', priceCents: 6500, serviceFeeBps: 200, serviceFeePayer: 'DINER', refundCutoffHours: 48 }).returning();
  await db.insert(s.experienceSessions).values([{ experienceId: exp.id, startAt: new Date(Date.now() + 7 * 86_400_000), capacity: 12 }, { experienceId: exp.id, startAt: new Date(Date.now() + 14 * 86_400_000), capacity: 12 }]);
  await db.insert(s.experienceAddOns).values({ experienceId: exp.id, name: 'Cheese board', priceCents: 1800 });

  // shared kitchen with two virtual brands served from a second "location" (pickup front)
  const [kitchen] = await db.insert(s.kitchens).values({ organizationId: org.id, name: 'Demo Shared Kitchen', addressLine1: '400 W 14th St', city: 'New York', region: 'NY', postalCode: '10014', lat: 40.7418, lng: -74.0067, isShared: true }).returning();
  await db.insert(s.stations).values([{ kitchenId: kitchen.id, code: 'GRILL', name: 'Grill' }, { kitchenId: kitchen.id, code: 'COLD', name: 'Cold' }, { kitchenId: kitchen.id, code: 'FRY', name: 'Fry' }, { kitchenId: kitchen.id, code: 'PACK', name: 'Packing' }]);
  const [brandA] = await db.insert(s.brands).values({ organizationId: org.id, legalSellerId: seller.id, name: 'Smash Society', slug: 'smash-society', description: 'Smash burgers', royaltyBps: 0 }).returning();
  const [brandB] = await db.insert(s.brands).values({ organizationId: org.id, legalSellerId: seller.id, name: 'Bowl Theory', slug: 'bowl-theory', description: 'Grain bowls by chef-creator', royaltyBps: 500 }).returning();
  await db.insert(s.kitchenBrands).values([{ kitchenId: kitchen.id, brandId: brandA.id }, { kitchenId: kitchen.id, brandId: brandB.id }]);
  const [kloc] = await db.insert(s.locations).values({ organizationId: org.id, legalSellerId: seller.id, kitchenId: kitchen.id, name: 'Demo Kitchen Collective', slug: 'demo-kitchen-collective', description: 'Made at Gutad food hall: mix dishes from every menu here in one order, delivered together.', platformOperated: true, cuisine: ['burgers', 'bowls'], addressLine1: '400 W 14th St', city: 'New York', region: 'NY', postalCode: '10014', lat: 40.7418, lng: -74.0067, status: 'LIVE', verifiedAt: new Date(), acceptsPickup: true, acceptsDelivery: true, deliveryFleet: 'PLATFORM', deliveryRadiusKm: 5, taxRateBps: 888, defaultPrepMinutes: 15, heroImageUrl: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=1200' }).returning();
  await db.insert(s.reservationPolicies).values({ locationId: kloc.id });
  await db.insert(s.publications).values([{ locationId: kloc.id, kind: 'LISTING', channel: 'MARKETPLACE', slug: 'l-demo-kitchen' }, { locationId: kloc.id, kind: 'ORDER_LINK', channel: 'DIRECT', slug: 'order-demo-kitchen' }]);
  await db.insert(s.contractLocations).values({ contractId: contract.id, locationId: kloc.id, entitlements: { ordering: true, delivery: true, sharedKitchen: true } });
  const [beef] = await db.insert(s.ingredients).values({ name: 'Ground beef', unit: 'g', costCentsPerUnit: 1 }).returning();
  const [rice] = await db.insert(s.ingredients).values({ name: 'Brown rice', unit: 'g', costCentsPerUnit: 0 }).returning();
  await db.insert(s.ingredientStock).values([{ kitchenId: kitchen.id, ingredientId: beef.id, onHand: 20000, parLevel: 5000 }, { kitchenId: kitchen.id, ingredientId: rice.id, onHand: 30000, parLevel: 5000 }]);
  const [smashRecipe] = await db.insert(s.recipes).values({ name: 'Double smash', yieldPortions: 1, laborMinutes: 6 }).returning();
  await db.insert(s.recipeLines).values({ recipeId: smashRecipe.id, ingredientId: beef.id, quantity: 180 });
  const [bowlRecipe] = await db.insert(s.recipes).values({ name: 'Harvest bowl', yieldPortions: 1, laborMinutes: 5 }).returning();
  await db.insert(s.recipeLines).values({ recipeId: bowlRecipe.id, ingredientId: rice.id, quantity: 220 });
  const [menuA] = await db.insert(s.menus).values({ organizationId: org.id, locationId: kloc.id, brandId: brandA.id, name: 'Smash Society' }).returning();
  const [catA] = await db.insert(s.menuCategories).values({ menuId: menuA.id, name: 'Burgers' }).returning();
  await db.insert(s.menuItems).values([{ categoryId: catA.id, name: 'Double smash', priceCents: 1400, stationCode: 'GRILL', recipeId: smashRecipe.id, imageUrl: 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=800' }, { categoryId: catA.id, name: 'Crinkle fries', priceCents: 600, stationCode: 'FRY' }]);
  const [menuB] = await db.insert(s.menus).values({ organizationId: org.id, locationId: kloc.id, brandId: brandB.id, name: 'Bowl Theory' }).returning();
  const [catB] = await db.insert(s.menuCategories).values({ menuId: menuB.id, name: 'Bowls' }).returning();
  await db.insert(s.menuItems).values([{ categoryId: catB.id, name: 'Harvest bowl', priceCents: 1500, stationCode: 'COLD', recipeId: bowlRecipe.id, dietaryTags: ['vegan'] }, { categoryId: catB.id, name: 'Miso salmon bowl', priceCents: 1800, stationCode: 'GRILL', allergens: ['fish', 'soy'] }]);
  await db.insert(s.openingHours).values([0, 1, 2, 3, 4, 5, 6].map((d) => ({ locationId: kloc.id, dayOfWeek: d, opens: '00:00', closes: '23:59', service: 'ALL' })));

  // promo + campaign + meal kit
  await db.insert(s.coupons).values({ code: 'WELCOME10', kind: 'PERCENT', value: 1000, funder: 'PLATFORM', minSubtotalCents: 1500, perUserLimit: 1, locationIds: [], channels: [] });
  await db.insert(s.mealKitProducts).values([{ sku: 'KIT-BISTRO-DATE', name: 'Bistro date night kit', description: 'Two-course dinner for two, 30 minutes.', priceCents: 5900, weightGrams: 2400, shipRegions: ['NY', 'NJ', 'CT'], leadDays: 2, stockOnHand: 50, locationId: loc.id }, { sku: 'KIT-BRUNCH', name: 'Sunday brunch box', priceCents: 4500, shipRegions: ['NY', 'NJ'], leadDays: 3, stockOnHand: 30, locationId: loc.id }]);
  await db.insert(s.guestProfiles).values({ organizationId: org.id, locationId: loc.id, userId: customer.id, name: customer.name!, email: customer.email, phone: customer.phone, tags: ['regular'], visitCount: 3, orderCount: 5, lifetimeSpendCents: 24_000, lastVisitAt: new Date(Date.now() - 5 * 86_400_000) });
  await db.insert(s.addresses).values({ userId: customer.id, label: 'Home', line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975, isDefault: true });

  log(`demo ready: location ${loc.id} (${loc.slug}), kitchen location ${kloc.id}, owner owner@demo.gutad.io / merchant12345, customer customer@demo.gutad.io / customer12345, admin ${adminEmail}`);
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', e);
  process.exit(1);
});
