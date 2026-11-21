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
import { seedPlanCatalog } from '../modules/contracts/plans.service';
import { CHEF_AGREEMENT_VERSION } from '@gutad/shared';
import { randomUUID } from 'node:crypto';
import { ChefOptionsService } from '../modules/chefs/chef-options.service';

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
      { name: 'Gutad+', priceCents: 799, interval: 'MONTH', trialDays: 7, benefits: { freeDeliveryAboveCents: 1500, priorityWaitlist: true, serviceFeeWaived: true, creditCentsPerMonth: 0 } },
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

  if (await seedPlanCatalog(db)) log('created plan catalog');
  // approved customer response templates (support & operations); existing ones are left as edited
  await db
    .insert(s.messageTemplates)
    .values([
      { key: 'delay_kitchen', title: 'Kitchen running late', category: 'DELAY', body: 'Hi {{name}}, the kitchen is running a little behind on order {{number}}. We are on it and will update you as soon as it is ready. Sorry for the wait!' },
      { key: 'delay_courier', title: 'Courier delayed', category: 'DELAY', body: 'Hi {{name}}, your order {{number}} is ready and we are getting a courier to it now. Thanks for your patience.' },
      { key: 'item_unavailable', title: 'Item unavailable', category: 'ITEM', body: 'Hi {{name}}, one item in order {{number}} is unavailable today. Open the order in the app to pick a replacement or take a credit.' },
      { key: 'refund_issued', title: 'Refund issued', category: 'REFUND', body: 'Hi {{name}}, we have issued a refund for order {{number}}. It can take 5–10 business days to appear on your statement.' },
      { key: 'credit_issued', title: 'Credit added', category: 'REFUND', body: 'Hi {{name}}, we added a credit to your Gutad account for the trouble with order {{number}}. It applies automatically at your next checkout.' },
      { key: 'pickup_reminder', title: 'Pickup reminder', category: 'PICKUP', body: 'Hi {{name}}, order {{number}} is ready and waiting for you at the pickup shelf.' },
    ])
    .onConflictDoNothing();

  if (process.env.SEED_DEMO === 'false') {
    await pool.end();
    return;
  }

  await seedDemoChef(db, log);
  await seedDemoChefDishes(db, log);
  await seedDemoChefOptions(db, log);
  await seedDemoChefAmara(db, log);

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
  const [demoDriver] = await db.insert(s.drivers).values({ userId: driverUser.id, status: 'APPROVED', applicationStatus: 'APPROVED', lifecycleStatus: 'ACTIVE', city: 'New York', vehicle: 'Bike', licenseVerified: true, isAvailable: true, lastLat: 40.7306, lastLng: -73.9866, lastSeenAt: new Date(), payoutAccountId: 'mock_acct_driver', onboarding: { payout: { method: 'BANK', accountHolder: 'Drew Driver', accountLast4: '4242', taxFormAcceptedAt: new Date().toISOString() } } }).returning();
  // Courier R1: the demo courier has passed every eligibility check
  await db.insert(s.courierEligibility).values(['IDENTITY', 'VEHICLE', 'SCREENING', 'PAYOUT', 'AGREEMENT', 'TRAINING', 'EQUIPMENT'].map((check) => ({ driverId: demoDriver.id, check, status: 'PASSED', note: 'Demo courier' })));

  const [org] = await db.insert(s.organizations).values({ name: 'Demo Bistro Group', slug: 'demo-bistro', kind: 'MERCHANT', billingEmail: owner.email, status: 'LIVE', featureFlags: {} }).returning();
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
  // 25 growth examples (paused so they don't change other prices until someone switches them on)
  await db.insert(s.coupons).values({ code: `AUTO-LUNCH-${loc.id.slice(0, 4).toUpperCase()}`, name: 'Weekday lunch: 10% off', automatic: true, organizationId: org.id, kind: 'PERCENT', value: 1000, funder: 'MERCHANT', minSubtotalCents: 1500, perUserLimit: 0, locationIds: [loc.id], channels: [], daysOfWeek: [1, 2, 3, 4, 5], startTime: '11:00', endTime: '14:00', stacking: 'STACKABLE', priority: 10, isActive: false });
  await db.insert(s.challenges).values({ name: '3 orders in 14 days', description: 'Complete three orders within 14 days and get $5 in Gutad credit.', goalOrders: 3, windowDays: 14, minSubtotalCents: 1000, rewardCents: 500, rewardExpiresDays: 30, maxCompletions: 1, isActive: false });
  await db.insert(s.platformSettings).values([
    { key: 'giftcards.limits', value: { minCardCents: 500, maxCardCents: 50000, maxPurchasesPerDay: 3, maxCentsPerDay: 50000, reviewAboveCents: 25000, maxFailedRedeemsPerHour: 5 } },
    { key: 'membership.dunning', value: { retryDays: [1, 3, 5], graceDays: 7 } },
    { key: 'growth.referrals', value: { rewardPoints: 500, reviewOnSignals: true } },
    { key: 'growth.contributionMarginBps', value: 3000 },
  ]).onConflictDoNothing();
  await db.insert(s.mealKitProducts).values([{ sku: 'KIT-BISTRO-DATE', name: 'Bistro date night kit', description: 'Two-course dinner for two, 30 minutes.', priceCents: 5900, weightGrams: 2400, shipRegions: ['NY', 'NJ', 'CT'], leadDays: 2, stockOnHand: 50, locationId: loc.id }, { sku: 'KIT-BRUNCH', name: 'Sunday brunch box', priceCents: 4500, shipRegions: ['NY', 'NJ'], leadDays: 3, stockOnHand: 30, locationId: loc.id }]);
  await db.insert(s.guestProfiles).values({ organizationId: org.id, locationId: loc.id, userId: customer.id, name: customer.name!, email: customer.email, phone: customer.phone, tags: ['regular'], visitCount: 3, orderCount: 5, lifetimeSpendCents: 24_000, lastVisitAt: new Date(Date.now() - 5 * 86_400_000) });
  await db.insert(s.addresses).values({ userId: customer.id, label: 'Home', line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975, isDefault: true });

  log(`demo ready: location ${loc.id} (${loc.slug}), kitchen location ${kloc.id}, owner owner@demo.gutad.io / merchant12345, customer customer@demo.gutad.io / customer12345, admin ${adminEmail}`);
  await pool.end();
}

/** Customer options and approved extras for Bestie Carlos's customizable dishes (added once). */
async function seedDemoChefOptions(db: ReturnType<typeof createDb>, log: (m: string) => void) {
  const [p] = await db.select().from(s.chefProfiles).where(eq(s.chefProfiles.slug, 'chef-carlos')).limit(1);
  if (!p) return;
  const dishes = await db.select().from(s.chefDishes).where(eq(s.chefDishes.chefProfileId, p.id));
  const spaghetti = dishes.find((d) => d.dishName === 'Spaghetti');
  const cake = dishes.find((d) => d.dishName === 'Celebration layer cake');
  if (!spaghetti || (spaghetti.optionsConfig as unknown[]).length) return;
  const u = () => randomUUID();
  const o = (name: string, priceCents = 0, extra: Record<string, unknown> = {}) => ({ id: u(), name, priceCents, ...extra });
  const large = o('Large', 500, { portionDesc: '650 g' });
  const shrimp = o('Shrimp', 500, { addsAllergens: ['shellfish'], portionDesc: '6 shrimp', prepMinutesDelta: 5 });
  const spaghettiCfg = [
    { id: u(), name: 'Pasta portion', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, templateKey: 'portion', options: [o('Regular', 0, { isDefault: true, portionDesc: '450 g' }), large] },
    { id: u(), name: 'Sauce', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, templateKey: 'sauce', options: [o('Light'), o('Standard', 0, { isDefault: true }), o('Extra', 150)] },
    { id: u(), name: 'Cheese', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, templateKey: 'cheese', description: 'Removing cheese does not make the dish milk-free; the sauce is finished with butter.', options: [o('None'), o('Standard', 0, { isDefault: true }), o('Extra', 200)] },
    { id: u(), name: 'Add a protein', selectionType: 'SINGLE', required: false, minSelect: 0, maxSelect: 1, templateKey: 'protein', options: [o('Beef meatballs', 400, { removesDietaryTags: ['vegetarian', 'vegan'], portionDesc: '4 meatballs', addsAllergens: ['egg'] }), o('Grilled chicken', 350, { removesDietaryTags: ['vegetarian', 'vegan'], portionDesc: '120 g' }), shrimp] },
    { id: u(), name: 'Shrimp style', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, parentOptionId: shrimp.id, options: [o('Garlic butter', 0, { isDefault: true, addsAllergens: ['milk'] }), o('Spicy arrabbiata', 0)] },
    { id: u(), name: 'Extra toppings', selectionType: 'QUANTITY', required: false, minSelect: 0, maxSelect: 4, templateKey: 'toppings', options: [o('Mushrooms', 150, { maxQty: 2, portionDesc: '30 g', rules: { [large.id]: { maxQty: 3 } } }), o('Fresh basil', 50, { maxQty: 2 })] },
    { id: u(), name: 'Included', selectionType: 'INCLUDED', required: false, minSelect: 0, maxSelect: 0, templateKey: 'included', description: 'Cooked into the sauce; cannot be removed individually.', options: [o('Garlic, onion and olive oil', 0, { locked: true })] },
  ];
  const cakeCfg = [
    { id: u(), name: 'Size', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, templateKey: 'portion', options: [o('8-inch (serves 12)', 0, { isDefault: true }), o('10-inch (serves 20)', 2500, { prepMinutesDelta: 60 })] },
    { id: u(), name: 'Flavor', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, options: [o('Vanilla', 0, { isDefault: true }), o('Chocolate', 0), o('Lemon', 0)] },
    { id: u(), name: 'Fruit', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, options: [o('No fruit'), o('Seasonal fruit', 0, { isDefault: true }), o('Extra fruit', 800)] },
  ];
  const svc = new ChefOptionsService(db as never, {} as never, {} as never, {} as never);
  await db.update(s.chefDishes).set({ optionsConfig: spaghettiCfg }).where(eq(s.chefDishes.id, spaghetti.id));
  await svc.materialize({ ...spaghetti, optionsConfig: spaghettiCfg }, spaghettiCfg as never, db);
  if (cake) {
    await db.update(s.chefDishes).set({ optionsConfig: cakeCfg }).where(eq(s.chefDishes.id, cake.id));
    await svc.materialize({ ...cake, optionsConfig: cakeCfg }, cakeCfg as never, db);
  }
  await db.insert(s.chefExtras).values([
    { chefProfileId: p.id, name: 'Burrata', synonyms: ['mozzarella', 'cheese'], portionDesc: '1 ball (100 g)', priceCents: 600, maxQty: 1, allergens: ['milk'], removesDietaryTags: ['vegan'], allDishes: false, dishIds: [spaghetti.id], status: 'APPROVED' },
    { chefProfileId: p.id, name: 'Chili flakes', synonyms: ['chilli', 'pepper', 'spicy'], portionDesc: 'pinch', priceCents: 0, maxQty: 2, allDishes: true, status: 'APPROVED' },
    { chefProfileId: p.id, name: 'Truffle oil', synonyms: ['truffle'], portionDesc: '5 ml drizzle', priceCents: 300, maxQty: 1, allDishes: false, dishIds: [spaghetti.id], status: 'APPROVED' },
  ]);
  const [fresh] = await db.select().from(s.chefDishes).where(eq(s.chefDishes.id, spaghetti.id)).limit(1);
  await svc.syncExtrasForDish(fresh, db);
  if (cake) { const [fc] = await db.select().from(s.chefDishes).where(eq(s.chefDishes.id, cake.id)).limit(1); await svc.syncExtrasForDish(fc, db); }
  log('demo chef options ready (Spaghetti and celebration cake customizable; 3 approved extras)');
}

/** Bestie Carlos's live demo dishes (added once, also on databases seeded before dishes existed). */
async function seedDemoChefDishes(db: ReturnType<typeof createDb>, log: (m: string) => void) {
  const [p] = await db.select().from(s.chefProfiles).where(eq(s.chefProfiles.slug, 'chef-carlos')).limit(1);
  if (!p || !p.locationId) return;
  const [has] = await db.select({ id: s.chefDishes.id }).from(s.chefDishes).where(eq(s.chefDishes.chefProfileId, p.id)).limit(1);
  if (has) return;
  let [menu] = await db.select().from(s.menus).where(eq(s.menus.locationId, p.locationId)).limit(1);
  if (!menu) [menu] = await db.insert(s.menus).values({ organizationId: p.organizationId, locationId: p.locationId, name: 'Bestie Carlos menu', channels: ['MARKETPLACE', 'DIRECT'] }).returning();
  const [pasta] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Pasta', sortOrder: 0 }).returning();
  const [cakes] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Celebration cakes & pies', sortOrder: 1 }).returning();
  const dishes = [
    { cat: pasta.id, dishName: 'Spaghetti', description: 'Slow-simmered San Marzano tomato sauce, fresh basil and parmigiano over bronze-cut spaghetti.', priceCents: 1600, portionDesc: '1 bowl (450 g)', ingredients: ['spaghetti', 'San Marzano tomatoes', 'olive oil', 'garlic', 'basil', 'parmigiano'], allergens: ['wheat', 'milk'], dietaryTags: ['vegetarian'], mode: 'CUSTOMIZABLE', acceptsSpecialRequests: true, fulfillmentFormat: 'HOT', prepMinutes: 30, photo: 'https://images.unsplash.com/photo-1598866594230-a7c12756260f?w=1200' },
    { cat: pasta.id, dishName: 'Beef lasagna', description: 'Layers of fresh pasta, slow-cooked beef ragù, béchamel and mozzarella. Chilled; reheat 35 minutes at 375°F.', priceCents: 2400, portionDesc: 'Tray for 2 (900 g)', ingredients: ['pasta sheets', 'beef', 'tomato', 'onion', 'carrot', 'béchamel', 'mozzarella'], allergens: ['wheat', 'milk', 'egg'], dietaryTags: [], mode: 'FIXED', acceptsSpecialRequests: false, fulfillmentFormat: 'CHILLED_REHEAT', prepMinutes: 90, photo: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=1200' },
    { cat: cakes.id, dishName: 'Pumpkin pie', description: 'Spiced pumpkin custard in an all-butter crust. Order ahead for Thanksgiving.', priceCents: 3200, portionDesc: '9-inch pie, serves 8', ingredients: ['pumpkin', 'eggs', 'cream', 'brown sugar', 'cinnamon', 'nutmeg', 'flour', 'butter'], allergens: ['wheat', 'milk', 'egg'], dietaryTags: ['vegetarian'], mode: 'FIXED', acceptsSpecialRequests: false, fulfillmentFormat: 'ROOM_TEMP', prepMinutes: 180, minLeadDays: 3, dailyCapacity: 8, photo: 'https://images.unsplash.com/photo-1509461399763-ae67a981b254?w=1200' },
    { cat: cakes.id, dishName: 'Celebration layer cake', description: 'Vanilla sponge, Italian meringue buttercream and seasonal fruit.', priceCents: 6500, portionDesc: '8-inch cake, serves 12', ingredients: ['flour', 'eggs', 'butter', 'sugar', 'vanilla', 'seasonal fruit'], allergens: ['wheat', 'milk', 'egg'], dietaryTags: ['vegetarian'], mode: 'CUSTOMIZABLE', acceptsSpecialRequests: true, fulfillmentFormat: 'ROOM_TEMP', prepMinutes: 240, minLeadDays: 5, dailyCapacity: 3, photo: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=1200' },
  ];
  for (const [i, d] of dishes.entries()) {
    const [item] = await db.insert(s.menuItems).values({ categoryId: d.cat, name: d.dishName, description: d.description, priceCents: d.priceCents, imageUrl: d.photo, photos: [d.photo], allergens: d.allergens, dietaryTags: d.dietaryTags, servingSize: d.portionDesc, cookMinutes: d.prepMinutes, handling: d.fulfillmentFormat === 'HOT' ? ['HOT'] : d.fulfillmentFormat === 'CHILLED_REHEAT' ? ['COLD'] : [], isActive: true, sortOrder: i }).returning();
    await db.insert(s.chefDishes).values({ menuItemId: item.id, chefProfileId: p.id, locationId: p.locationId, dishName: d.dishName, description: d.description, portionDesc: d.portionDesc, ingredients: d.ingredients, allergensConfirmed: true, mode: d.mode, acceptsSpecialRequests: d.acceptsSpecialRequests, fulfillmentFormat: d.fulfillmentFormat, prepMinutes: d.prepMinutes, minLeadDays: d.minLeadDays ?? null, dailyCapacity: d.dailyCapacity ?? null, photos: [d.photo], reviewStatus: 'PUBLISHED', publishedAt: new Date(), submittedAt: new Date() });
  }
  log('demo chef dishes ready (Bestie Carlos: 4 live dishes)');
}

/** Gutad Chef Network demo: Bestie Carlos, approved, payouts connected, accepting orders (idempotent). */
async function seedDemoChef(db: ReturnType<typeof createDb>, log: (m: string) => void) {
  const email = 'carlos@demo.gutad.io';
  const [exists] = await db.select().from(s.users).where(eq(s.users.email, email)).limit(1);
  if (exists) return;
  const [u] = await db.insert(s.users).values({ email, passwordHash: await argon2.hash('chef12345'), name: 'Carlos Mendes', phone: '+12125550188', roles: ['CUSTOMER', 'CHEF'], emailVerifiedAt: new Date() }).returning();
  const data = {
    account: { phone: '+12125550188', agreementVersion: CHEF_AGREEMENT_VERSION, agreedAt: new Date().toISOString() },
    identity: { legalName: 'Carlos Mendes', displayName: 'Bestie Carlos', businessType: 'INDIVIDUAL' },
    profile: { bio: 'Italian-Brazilian home-style pasta and celebration cakes, made from scratch in a licensed Brooklyn commissary.', cuisines: ['Italian', 'Bakery & desserts'], experienceYears: 12, languages: ['English', 'Portuguese', 'Italian'], serviceCity: 'New York', serviceRegion: 'NY', serviceRadiusKm: 12 },
    kitchen: { kitchenType: 'SHARED_COMMISSARY', name: 'Brooklyn Commissary', operatorName: 'Brooklyn Commissary LLC', addressLine1: '200 Flushing Ave', city: 'Brooklyn', region: 'NY', postalCode: '11205', pickupAccess: 'Gate B, ring Kitchen 4', dailyCapacity: 40 },
    operating: { cookingDays: [2, 3, 4, 5, 6], cutoffHour: 12, minLeadDays: 1, dailyCapacity: 30, instantOrders: false, scheduledOrders: true, pickup: true, delivery: true, maxAdvanceDays: 45 },
    payments: { country: 'US', earningsAgreementAccepted: true },
    menu: { dishes: [{ name: 'Spaghetti', priceCents: 1600, portion: '1 bowl (450 g)', allergens: ['wheat', 'milk', 'egg'], mode: 'CUSTOMIZABLE' }] },
    readiness: { packagingAck: true, handlingTrainingAck: true, allergenTrainingAck: true },
  };
  const [app] = await db.insert(s.chefApplications).values({ userId: u.id, status: 'APPROVED', data, displayName: 'Bestie Carlos', region: 'NY', city: 'Brooklyn', kitchenType: 'SHARED_COMMISSARY', percentComplete: 100, submittedAt: new Date(), decidedAt: new Date(), decisionReason: 'Demo chef', history: [{ at: new Date().toISOString(), action: 'APPROVED', note: 'Demo chef' }] }).returning();
  const [org] = await db.insert(s.organizations).values({ name: 'Bestie Carlos', slug: 'chef-carlos-demo', kind: 'CHEF', status: 'LIVE', featureFlags: {} }).returning();
  await db.insert(s.orgMemberships).values({ userId: u.id, organizationId: org.id, role: 'MERCHANT_OWNER', acceptedAt: new Date() });
  await db.update(s.chefApplications).set({ organizationId: org.id }).where(eq(s.chefApplications.id, app.id));
  const [seller] = await db.insert(s.legalSellers).values({ organizationId: org.id, legalName: 'Carlos Mendes', country: 'US', payoutProvider: 'mock', payoutAccountId: 'mock_acct_chef_carlos', payoutOnboardingState: 'COMPLETE', bankLast4: '6789', beneficiaryName: 'Carlos Mendes' }).returning();
  const [loc] = await db.insert(s.locations).values({ organizationId: org.id, legalSellerId: seller.id, name: 'Bestie Carlos’s kitchen', slug: 'chef-carlos-kitchen', description: data.profile.bio, cuisine: ['italian', 'bakery'], phone: '+12125550188', addressLine1: '200 Flushing Ave', city: 'Brooklyn', region: 'NY', postalCode: '11205', lat: 40.6981, lng: -73.9712, timezone: 'America/New_York', pickupInstructions: 'Gate B, ring Kitchen 4', courierInstructions: 'Gate B, ring Kitchen 4', status: 'LIVE', verifiedAt: new Date(), acceptsPickup: true, acceptsDelivery: true, chefKitchen: true, defaultPrepMinutes: 45, scheduleLeadMinutes: 24 * 60, deliveryRadiusKm: 12, taxRateBps: 888 }).returning();
  await db.insert(s.openingHours).values([2, 3, 4, 5, 6].map((d) => ({ locationId: loc.id, dayOfWeek: d, opens: '09:00', closes: '20:00', service: 'ALL' })));
  await db.insert(s.chefProfiles).values({ organizationId: org.id, userId: u.id, applicationId: app.id, locationId: loc.id, displayName: 'Bestie Carlos', slug: 'chef-carlos', legalName: 'Carlos Mendes', bio: data.profile.bio, cuisines: data.profile.cuisines, languages: data.profile.languages, experienceYears: 12, serviceCity: 'New York', serviceRegion: 'NY', serviceRadiusKm: 12, kitchenType: 'SHARED_COMMISSARY', operating: { cookingDays: [2, 3, 4, 5, 6], cutoffHour: 12, minLeadDays: 1, dailyCapacity: 30, instantOrders: false, scheduledOrders: true, maxAdvanceDays: 45 }, verifiedCredentials: ['GOV_ID', 'FOOD_HANDLER', 'KITCHEN_PERMIT', 'KITCHEN_USE_AGREEMENT', 'LIABILITY_INSURANCE'], brandAgreementAcceptedAt: new Date(), status: 'ACTIVE', acceptingOrders: true });
  log(`demo chef ready: ${email} / chef12345 (Bestie Carlos, location ${loc.id})`);
}

/** Second demo chef (multi-chef checkout): Bestie Amara, West African, approved and accepting orders (idempotent). */
async function seedDemoChefAmara(db: ReturnType<typeof createDb>, log: (m: string) => void) {
  const email = 'amara@demo.gutad.io';
  const [exists] = await db.select().from(s.users).where(eq(s.users.email, email)).limit(1);
  if (exists) return;
  const op = { cookingDays: [3, 4, 5, 6, 0], cutoffHour: 15, minLeadDays: 1, dailyCapacity: 25, instantOrders: false, scheduledOrders: true, pickup: true, delivery: true, maxAdvanceDays: 30, opens: '11:00', closes: '19:00', lateRefundPct: 50 };
  const bio = 'Nigerian and Ghanaian home cooking: smoky party jollof, egusi and suya, cooked in a licensed Bed-Stuy kitchen.';
  const [u] = await db.insert(s.users).values({ email, passwordHash: await argon2.hash('chef12345'), name: 'Amara Okafor', phone: '+12125550199', roles: ['CUSTOMER', 'CHEF'], emailVerifiedAt: new Date() }).returning();
  const [app] = await db.insert(s.chefApplications).values({ userId: u.id, status: 'APPROVED', data: { identity: { legalName: 'Amara Okafor', displayName: 'Bestie Amara', businessType: 'INDIVIDUAL' }, operating: op }, displayName: 'Bestie Amara', region: 'NY', city: 'Brooklyn', kitchenType: 'COTTAGE_HOME', percentComplete: 100, submittedAt: new Date(), decidedAt: new Date(), decisionReason: 'Demo chef', history: [{ at: new Date().toISOString(), action: 'APPROVED', note: 'Demo chef' }] }).returning();
  const [org] = await db.insert(s.organizations).values({ name: 'Bestie Amara', slug: 'chef-amara-demo', kind: 'CHEF', status: 'LIVE', featureFlags: {} }).returning();
  await db.insert(s.orgMemberships).values({ userId: u.id, organizationId: org.id, role: 'MERCHANT_OWNER', acceptedAt: new Date() });
  await db.update(s.chefApplications).set({ organizationId: org.id }).where(eq(s.chefApplications.id, app.id));
  const [seller] = await db.insert(s.legalSellers).values({ organizationId: org.id, legalName: 'Amara Okafor', country: 'US', payoutProvider: 'mock', payoutAccountId: 'mock_acct_chef_amara', payoutOnboardingState: 'COMPLETE', bankLast4: '4321', beneficiaryName: 'Amara Okafor' }).returning();
  const [loc] = await db.insert(s.locations).values({ organizationId: org.id, legalSellerId: seller.id, name: 'Bestie Amara’s kitchen', slug: 'chef-amara-kitchen', description: bio, cuisine: ['west african', 'nigerian'], phone: '+12125550199', addressLine1: '410 Tompkins Ave', city: 'Brooklyn', region: 'NY', postalCode: '11216', lat: 40.6845, lng: -73.9440, timezone: 'America/New_York', pickupInstructions: 'Side door, ring Kitchen', courierInstructions: 'Side door, ring Kitchen', status: 'LIVE', verifiedAt: new Date(), acceptsPickup: true, acceptsDelivery: true, chefKitchen: true, defaultPrepMinutes: 45, scheduleLeadMinutes: 24 * 60, deliveryRadiusKm: 12, taxRateBps: 888 }).returning();
  await db.insert(s.openingHours).values(op.cookingDays.map((d) => ({ locationId: loc.id, dayOfWeek: d, opens: op.opens, closes: op.closes, service: 'ALL' })));
  const [p] = await db.insert(s.chefProfiles).values({ organizationId: org.id, userId: u.id, applicationId: app.id, locationId: loc.id, displayName: 'Bestie Amara', slug: 'chef-amara', legalName: 'Amara Okafor', bio, cuisines: ['West African'], languages: ['English', 'Igbo', 'Twi'], experienceYears: 9, serviceCity: 'New York', serviceRegion: 'NY', serviceRadiusKm: 12, kitchenType: 'COTTAGE_HOME', operating: op, verifiedCredentials: ['GOV_ID', 'FOOD_HANDLER', 'KITCHEN_PERMIT', 'LIABILITY_INSURANCE'], brandAgreementAcceptedAt: new Date(), status: 'ACTIVE', acceptingOrders: true }).returning();
  const [menu] = await db.insert(s.menus).values({ organizationId: org.id, locationId: loc.id, name: 'Bestie Amara menu', channels: ['MARKETPLACE', 'DIRECT'] }).returning();
  const [mains] = await db.insert(s.menuCategories).values({ menuId: menu.id, name: 'Mains', sortOrder: 0 }).returning();
  const dishes = [
    { dishName: 'Party jollof rice', description: 'Smoky long-grain jollof with fried plantain. Serves 2.', priceCents: 2200, portionDesc: 'Tray for 2 (800 g)', ingredients: ['rice', 'tomato', 'red pepper', 'scotch bonnet', 'onion', 'thyme', 'plantain'], allergens: [], dietaryTags: ['vegan'], fulfillmentFormat: 'HOT', prepMinutes: 60, dailyCapacity: 15, photo: 'https://images.unsplash.com/photo-1604329760661-e71dc83f8f26?w=1200' },
    { dishName: 'Beef suya platter', description: 'Grilled spiced beef skewers with onion, tomato and yaji.', priceCents: 1900, portionDesc: '6 skewers', ingredients: ['beef', 'peanut', 'ginger', 'chili', 'onion', 'tomato'], allergens: ['peanuts'], dietaryTags: [], fulfillmentFormat: 'HOT', prepMinutes: 40, dailyCapacity: null, photo: 'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?w=1200' },
  ];
  for (const [i, d] of dishes.entries()) {
    const [item] = await db.insert(s.menuItems).values({ categoryId: mains.id, name: d.dishName, description: d.description, priceCents: d.priceCents, imageUrl: d.photo, photos: [d.photo], allergens: d.allergens, dietaryTags: d.dietaryTags, servingSize: d.portionDesc, cookMinutes: d.prepMinutes, handling: ['HOT'], isActive: true, sortOrder: i }).returning();
    await db.insert(s.chefDishes).values({ menuItemId: item.id, chefProfileId: p.id, locationId: loc.id, dishName: d.dishName, description: d.description, portionDesc: d.portionDesc, ingredients: d.ingredients, allergensConfirmed: true, mode: 'FIXED', fulfillmentFormat: d.fulfillmentFormat, prepMinutes: d.prepMinutes, dailyCapacity: d.dailyCapacity, photos: [d.photo], reviewStatus: 'PUBLISHED', publishedAt: new Date(), submittedAt: new Date() });
  }
  log(`demo chef ready: ${email} / chef12345 (Bestie Amara, 2 live dishes)`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', e);
  process.exit(1);
});
