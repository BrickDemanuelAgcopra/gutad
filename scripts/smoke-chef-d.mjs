// Chef Network Phase 4 checks (imported by smoke.mjs): advance ordering and capacity. Availability calendars per
// dish and per cart, notice periods and cutoff hours, cooking days, per-date overrides, holiday pauses, the admin
// advance cap, per-dish and per-kitchen daily limits, capacity holds during checkout (replaced by the same checkout
// session, never double-counted), confirmation at checkout, release on cancel, and the chef's calendar settings.

const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export async function chefPhaseD({ call, check, A, C }) {
  console.log('\n── Chef Network D: advance ordering and capacity');
  const carlos = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  check('demo chef signs in', !!carlos, null);
  const K = carlos;
  const dishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const pie = dishes.find((d) => d.dishName === 'Pumpkin pie');
  const sp = dishes.find((d) => d.dishName === 'Spaghetti');
  const locId = pie.location.id;
  const iso = async (date, time) => (await call('GET', `/public/locations/${locId}/local-time?date=${date}&time=${time}`)).json.iso;
  const quote = (lines, scheduledFor, token = C, holdKey) => call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor, lines, ...(holdKey ? { holdKey } : {}) }, token);

  // calendar settings start from the seed: Tue–Sat, noon cutoff, 1 day notice, 30/day, 45 days ahead
  const cal0 = (await call('GET', '/chef/calendar', undefined, K)).json;
  check('chef sees the cooking calendar with weekly settings', cal0.settings?.cookingDays?.join() === '2,3,4,5,6' && cal0.settings.cutoffHour === 12 && cal0.days?.length >= 30, cal0.settings);
  const original = cal0.settings;
  const custCal = await call('GET', '/chef/calendar', undefined, C);
  check('only chefs have a cooking calendar', custCal.status === 404 || custCal.status === 403, custCal.status);

  // dish availability: notice period, cutoff, cooking days and the advance window
  const av = (await call('GET', `/public/chef-dishes/${pie.id}/availability?to=${addDays(cal0.today, 60)}`)).json;
  const today = av.today;
  const avail = av.days.filter((d) => d.status === 'AVAILABLE');
  check('availability calendar lists dates with status, order-by time and times', av.days.length > 20 && avail.length > 5 && avail.every((d) => d.slots.length && d.orderBy), av.days?.slice(0, 3));
  check('the pie’s 3-day notice: nothing before today + 3', !!av.earliestDate && av.earliestDate >= addDays(today, 3) && av.rules.minLeadDays === 3, { e: av.earliestDate, today });
  check('dates inside the notice period read “ordering closed”', av.days.filter((d) => d.date < addDays(today, 3) && [2, 3, 4, 5, 6].includes(weekday(d.date))).every((d) => d.status === 'CUTOFF_PASSED'), av.days.slice(0, 4).map((d) => d.status));
  check('Sunday and Monday are not cooking days', av.days.filter((d) => [0, 1].includes(weekday(d.date)) && d.date <= av.latestDate).every((d) => d.status === 'NOT_COOKING'), null);
  check('dates past the advance window are not open yet (45 days)', av.latestDate === addDays(today, 45) && av.days.filter((d) => d.date > av.latestDate).every((d) => d.status === 'TOO_FAR'), av.latestDate);
  const e = av.days.find((d) => d.date === av.earliestDate);
  const ob = new Date(e.orderBy);
  const obLocal = new Intl.DateTimeFormat('en-CA', { timeZone: av.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(ob);
  check('order-by time = cutoff hour, notice days before (noon, 3 days earlier)', obLocal.startsWith(addDays(e.date, -3)) && obLocal.includes('12:00'), obLocal);
  const spAv = (await call('GET', `/public/chef-dishes/${sp.id}/availability`)).json;
  check('a dish without its own notice follows the chef (1 day)', spAv.rules.minLeadDays === 1 && spAv.earliestDate < av.earliestDate, spAv.rules);
  const loc = (await call('GET', `/public/locations/${locId}`)).json;
  check('the kitchen’s pickup times follow the cooking calendar (no times on non-cooking days)', loc.pickupTimes.filter((d) => [0, 1].includes(weekday(d.date))).every((d) => !d.slots.length) && loc.pickupTimes.some((d) => d.slots.length), null);

  // quotes enforce the calendar
  const one = [{ menuItemId: pie.menuItemId, quantity: 1 }];
  const noDate = await quote(one, null);
  check('chef carts must choose a day', noDate.status === 400 && noDate.json.code === 'SCHEDULE_REQUIRED', noDate.json);
  const tooSoonDay = av.days.find((d) => d.status === 'CUTOFF_PASSED');
  const late = await quote(one, await iso(tooSoonDay.date, '12:00'));
  check('an order past the cutoff is refused with the rule', late.status === 400 && late.json.code === 'CHEF_CUTOFF_PASSED' && /Order by 12 PM, 3 days before/.test(late.json.message), late.json);
  const sunday = av.days.find((d) => d.status === 'NOT_COOKING');
  const sun = await quote(one, await iso(sunday.date, '12:00'));
  check('an order on a non-cooking day is refused', sun.status === 400 && sun.json.code === 'CHEF_NOT_COOKING', sun.json);
  const far = await quote(one, await iso(addDays(av.latestDate, 3), '12:00'));
  check('an order beyond the advance window is refused', far.status === 400 && ['CHEF_TOO_FAR', 'CHEF_NOT_COOKING'].includes(far.json.code), far.json);
  const night = await quote(one, await iso(av.earliestDate, '03:00'));
  check('a time outside the pickup window is refused with the day’s times', night.status === 400 && night.json.code === 'CHEF_TIME_UNAVAILABLE' && night.json.slots?.length, night.json);
  const ok = await quote(one, await iso(av.earliestDate, e.slots[0]));
  check('an order inside the notice and cutoff is accepted', ok.status === 201 || (ok.status === 200 && ok.json.id), ok.json);

  // per-dish daily limit with holds (pie: 8 a day). Use a date nobody has booked yet.
  const freeDay = [...avail].reverse().find((d) => d.remaining === 8 && d.date !== av.earliestDate);
  const at = await iso(freeDay.date, freeDay.slots[0]);
  const k1 = `smoke-${globalThis.crypto.randomUUID()}`;
  const q1 = await quote([{ menuItemId: pie.menuItemId, quantity: 6 }], at, C, k1);
  check('a quote holds the date’s capacity (6 of 8 pies)', !!q1.json.id, q1.json);
  const afterHold = (await call('GET', `/public/chef-dishes/${pie.id}/availability?from=${freeDay.date}&to=${freeDay.date}`)).json.days[0];
  check('held portions count for everyone else (2 left)', afterHold.remaining === 2 && afterHold.status === 'AVAILABLE', afterHold);
  const own = (await call('GET', `/public/chef-dishes/${pie.id}/availability?from=${freeDay.date}&to=${freeDay.date}&holdKey=${k1}`)).json.days[0];
  check('the holder’s own checkout still sees its portions (8 left for them)', own.remaining === 8, own);
  const other = await quote([{ menuItemId: pie.menuItemId, quantity: 3 }], at, A);
  check('another customer can’t take more than what’s left (per-dish limit)', other.status === 400 && other.json.code === 'DISH_CAPACITY_FULL' && other.json.remaining === 2, other.json);
  const q2 = await quote([{ menuItemId: pie.menuItemId, quantity: 7 }], at, C, k1);
  check('re-pricing in the same checkout replaces its hold (7 now, not 13)', !!q2.json.id && q2.json.warnings?.some((w) => /1 more portion/.test(w)), q2.json);
  const left1 = (await call('GET', `/public/chef-dishes/${pie.id}/availability?from=${freeDay.date}&to=${freeDay.date}`)).json.days[0];
  check('only the latest hold counts (1 left)', left1.remaining === 1, left1);
  const stale = await call('POST', '/orders', { quoteId: q1.json.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() });
  check('checking out a replaced quote re-checks capacity and refuses an oversell before payment', stale.status === 409 && stale.json.code === 'DISH_CAPACITY_FULL', stale.json);
  const placed = await call('POST', '/orders', { quoteId: q2.json.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() });
  check('checkout turns the hold into the order’s confirmed portions', !!placed.json.id, placed.json);
  const after = (await call('GET', `/public/chef-dishes/${pie.id}/availability?from=${freeDay.date}&to=${freeDay.date}`)).json.days[0];
  check('confirmed portions keep counting after the hold (1 left)', after.remaining === 1 && after.status === 'AVAILABLE', after);
  const calB = (await call('GET', `/chef/calendar?from=${freeDay.date}&to=${freeDay.date}`, undefined, K)).json.days[0];
  check('the chef sees the booking per dish against its limit', calB.booked >= 7 && calB.orders >= 1 && calB.dishes.some((d) => d.name === 'Pumpkin pie' && d.units >= 7 && d.limit === 8), calB);
  if (placed.json.id) {
    const c = await call('POST', `/orders/${placed.json.id}/cancel`, { reason: 'smoke: plans changed' }, C);
    check('customer cancels the chef order', c.status < 300, c.json);
    const freed = (await call('GET', `/public/chef-dishes/${pie.id}/availability?from=${freeDay.date}&to=${freeDay.date}`)).json.days[0];
    check('a canceled order gives its portions back', freed.remaining === 8 && freed.status === 'AVAILABLE', freed);
  }

  // kitchen limit: per-date capacity override shared by every dish
  const kd = [...spAv.days].reverse().find((d) => d.status === 'AVAILABLE' && d.date !== freeDay.date);
  const setCap = (await call('PUT', `/chef/calendar/days/${kd.date}`, { capacity: 2, note: 'Small batch day' }, K)).json;
  check('chef sets a smaller kitchen capacity for one date', setCap.capacity === 2 && setCap.override?.note === 'Small batch day', setCap);
  const kq = await quote([{ menuItemId: sp.menuItemId, quantity: 3 }], await iso(kd.date, kd.slots[0]), A);
  check('the kitchen limit applies across dishes', kq.status === 400 && kq.json.code === 'KITCHEN_CAPACITY_FULL', kq.json);
  const kq2 = await quote([{ menuItemId: sp.menuItemId, quantity: 2 }], await iso(kd.date, kd.slots[0]), A);
  check('up to the kitchen limit is fine', !!kq2.json.id, kq2.json);
  const below = await call('PUT', `/chef/calendar/days/${kd.date}`, { capacity: 0 }, K);
  check('capacity can be lowered only to what’s booked (holds don’t block)', below.status === 200 || below.json.code === 'CAPACITY_BELOW_BOOKED', below.json);
  await call('PUT', `/chef/calendar/days/${kd.date}`, { capacity: null, note: null, open: null }, K);

  // per-date overrides: close a cooking day, open an extra day
  const closeDay = spAv.days.find((d) => d.status === 'AVAILABLE' && d.date !== kd.date && d.date !== freeDay.date && d.date > spAv.earliestDate);
  const closed = (await call('PUT', `/chef/calendar/days/${closeDay.date}`, { open: false }, K)).json;
  const closedAv = (await call('GET', `/public/chef-dishes/${sp.id}/availability?from=${closeDay.date}&to=${closeDay.date}`)).json.days[0];
  check('closing one cooking day removes it from the calendar', closed.open === false && closedAv.status === 'CLOSED' && !closedAv.slots.length, closedAv);
  await call('PUT', `/chef/calendar/days/${closeDay.date}`, { open: null }, K);
  const monday = spAv.days.find((d) => weekday(d.date) === 1 && d.date > addDays(today, 2) && d.status === 'NOT_COOKING');
  await call('PUT', `/chef/calendar/days/${monday.date}`, { open: true }, K);
  const monAv = (await call('GET', `/public/chef-dishes/${sp.id}/availability?from=${monday.date}&to=${monday.date}`)).json.days[0];
  check('opening an extra day (a Monday) makes it orderable with the default window', monAv.status === 'AVAILABLE' && monAv.slots.length > 4, monAv);
  const mq = await quote([{ menuItemId: sp.menuItemId, quantity: 1 }], await iso(monday.date, monAv.slots[0]), A);
  check('the extra day can be quoted', !!mq.json.id, mq.json);
  await call('PUT', `/chef/calendar/days/${monday.date}`, { open: null }, K);
  const pastDay = await call('PUT', `/chef/calendar/days/${addDays(today, -1)}`, { open: false }, K);
  check('past dates can’t be changed', pastDay.status === 400, pastDay.json);

  // holiday pause
  const ps = addDays(closeDay.date, 0), pe = addDays(closeDay.date, 6);
  const pause = await call('POST', '/chef/calendar/pauses', { startDate: ps, endDate: pe, reason: 'Family trip' }, K);
  const pauseRow = pause.json.code === 'HAS_ORDERS' ? (await call('POST', '/chef/calendar/pauses', { startDate: ps, endDate: pe, reason: 'Family trip', acknowledgeOrders: true }, K)).json : pause.json;
  check('chef adds a holiday pause (existing orders must be acknowledged)', !!pauseRow.id, pause.json);
  const pAv = (await call('GET', `/public/chef-dishes/${sp.id}/availability?from=${ps}&to=${pe}`)).json;
  check('every date in the pause reads “chef is away”', pAv.days.every((d) => d.status === 'PAUSED'), pAv.days.map((d) => d.status));
  const pq = await quote([{ menuItemId: sp.menuItemId, quantity: 1 }], await iso(ps, '12:00'), A);
  check('orders during a pause are refused', pq.status === 400 && pq.json.code === 'CHEF_PAUSED', pq.json);
  const bad = await call('POST', '/chef/calendar/pauses', { startDate: pe, endDate: ps }, K);
  check('a pause must end after it starts', bad.status === 400, bad.json);
  const calP = (await call('GET', '/chef/calendar', undefined, K)).json;
  check('the pause shows in the chef’s calendar', calP.pauses.some((p) => p.id === pauseRow.id && p.reason === 'Family trip'), calP.pauses);
  await call('DELETE', `/chef/calendar/pauses/${pauseRow.id}`, undefined, K);
  const unp = (await call('GET', `/public/chef-dishes/${sp.id}/availability?from=${ps}&to=${ps}`)).json.days[0];
  check('removing the pause reopens the dates', unp.status !== 'PAUSED', unp);

  // weekly settings
  const none = await call('PUT', '/chef/calendar/settings', { cookingDays: [] }, K);
  check('at least one cooking day is required', none.status === 400 && none.json.code === 'NO_COOKING_DAYS', none.json);
  const tooFar = await call('PUT', '/chef/calendar/settings', { maxAdvanceDays: 200 }, K);
  check('the admin cap limits how far ahead orders open (60 days)', tooFar.status === 400 && tooFar.json.code === 'ADVANCE_TOO_FAR' && tooFar.json.max === 60, tooFar.json);
  const changed = (await call('PUT', '/chef/calendar/settings', { cutoffHour: 18, cookingDays: [1, 2, 3, 4, 5, 6], opens: '10:00', closes: '19:00' }, K)).json;
  const spAv2 = (await call('GET', `/public/chef-dishes/${sp.id}/availability`)).json;
  const mon2 = spAv2.days.find((d) => weekday(d.date) === 1 && d.status === 'AVAILABLE');
  check('weekly settings change cooking days, cutoff and the pickup window', changed.settings?.cutoffHour === 18 && !!mon2 && mon2.slots[0] === '10:00' && mon2.slots[mon2.slots.length - 1] === '18:30', { s: changed.settings, mon2 });
  const restored = (await call('PUT', '/chef/calendar/settings', { cutoffHour: original.cutoffHour, cookingDays: original.cookingDays, opens: original.opens, closes: original.closes }, K)).json;
  check('settings restore', restored.settings?.cutoffHour === original.cutoffHour && restored.settings.cookingDays.join() === original.cookingDays.join(), restored.settings);

  // admin view and cart availability
  const chefs = (await call('GET', '/admin/chefs', undefined, A)).json;
  const cp = chefs.find((c) => c.slug === 'chef-carlos');
  const adminCal = await call('GET', `/admin/chefs/${cp.id}/calendar`, undefined, A);
  check('Gutad staff can see a chef’s calendar and bookings', adminCal.status === 200 && adminCal.json.days.length > 0 && adminCal.json.days.some((d) => d.booked > 0), adminCal.status);
  const custAdmin = await call('GET', `/admin/chefs/${cp.id}/calendar`, undefined, C);
  check('customers can’t see a chef’s bookings', custAdmin.status === 403, custAdmin.status);
  const cart = (await call('POST', `/public/chef-kitchens/${locId}/availability`, { lines: [{ menuItemId: pie.menuItemId, quantity: 1 }, { menuItemId: sp.menuItemId, quantity: 2 }] })).json;
  check('a cart’s calendar takes the strictest dish (pie’s 3-day notice applies to the whole cart)', cart.rules.minLeadDays === 3 && cart.earliestDate === av.earliestDate, cart.rules);
}
