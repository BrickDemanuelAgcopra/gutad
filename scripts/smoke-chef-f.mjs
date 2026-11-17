// Chef Network Phase 6 checks (imported by smoke.mjs): special requests and chef quotes. A customer asks for a change
// the dish's options don't cover; the chef asks a question, quotes (versioned), or declines; the customer asks for a
// revision, accepts and pays through normal checkout at the quoted price, quantity and date (used once); deadlines
// expire unanswered requests and unaccepted quotes; Gutad staff supervise, extend and close.

export async function chefPhaseF({ call, check, A, C }) {
  console.log('\n── Chef Network F: special requests and quotes');
  const K = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  const other = (await call('POST', '/auth/register', { email: `req-${Date.now()}@smoke.gutad.io`, password: 'customer12345', name: 'Other Customer' })).json.accessToken;
  const carlos = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const spaghetti = carlos.find((d) => d.dishName === 'Spaghetti');
  const lasagna = carlos.find((d) => d.dishName === 'Beef lasagna');
  const av = (await call('GET', `/public/chef-dishes/${spaghetti.id}/availability?quantity=2`)).json;
  const open = av.days.filter((d) => d.status === 'AVAILABLE');
  const day = open[Math.min(2, open.length - 1)];
  const otherDay = open.find((d) => d.date !== day.date);
  const closedDay = av.days.find((d) => d.status === 'NOT_COOKING');
  const isoAt = async (date, time) => (await call('GET', `/public/locations/${spaghetti.location.id}/local-time?date=${date}&time=${time}`)).json.iso;
  const ask = (body, token = C) => call('POST', '/chef-requests', { dishId: spaghetti.id, requestType: 'ADD', details: 'Please add sautéed shrimp to both bowls', ingredient: 'shrimp', servings: 2, requestedDate: day.date, reason: 'PREFERENCE', budgetCents: 4500, alternativesOk: true, ...body }, token);
  const quoteBody = (o = {}) => ({ kind: 'QUOTE', changes: 'Add 6 garlic-butter shrimp per bowl', unitPriceCents: 2100, allergens: ['wheat', 'milk', 'shellfish'], dietaryTags: [], serviceDate: day.date, ...o });

  const closed = await call('POST', '/chef-requests', { dishId: lasagna.id, requestType: 'ADD', details: 'Extra cheese please', servings: 1, requestedDate: day.date, reason: 'PREFERENCE' }, C);
  check('a dish that doesn’t take special requests refuses them', closed.status === 400 && closed.json.code === 'REQUESTS_CLOSED', closed.json);
  const anon = await call('POST', '/chef-requests', { dishId: spaghetti.id, requestType: 'ADD', details: 'Add shrimp please', servings: 1, requestedDate: day.date, reason: 'PREFERENCE' });
  check('sending a request needs an account', anon.status === 401, anon.status);
  if (closedDay) {
    const badDay = await ask({ requestedDate: closedDay.date });
    check('a request for a day the chef isn’t cooking is refused', badDay.status === 400 && badDay.json.code === 'REQUEST_DATE_UNAVAILABLE', badDay.json);
  }

  // create → question → reply
  const r1 = (await ask({})).json;
  check('a customer sends a special request (waiting for the chef, with a reply deadline)', r1.status === 'PENDING' && /^R-[0-9A-F]{6}$/.test(r1.code) && !!r1.respondBy && r1.viewerRole === 'CUSTOMER' && r1.can.withdraw && !r1.can.quote, { status: r1.status, code: r1.code });
  const peek = await call('GET', `/chef-requests/${r1.id}`, undefined, other);
  check('another customer can’t see the request', peek.status === 404, peek.status);
  const inbox = (await call('GET', '/chef/requests?status=needsReply', undefined, K)).json;
  check('the chef’s inbox lists it under “needs reply”', inbox.requests?.some((x) => x.id === r1.id) && inbox.counts.needsReply >= 1 && inbox.requests.find((x) => x.id === r1.id).customer?.name === 'Smoke', inbox.counts);
  const custQuote = await call('POST', `/chef/requests/${r1.id}/quote`, quoteBody(), C);
  check('the customer can’t quote their own request', custQuote.status === 403, custQuote.status);
  const q = (await call('POST', `/chef/requests/${r1.id}/question`, { body: 'Is this for an allergy, or just a preference?' }, K)).json;
  check('the chef asks a question (the customer now has to reply)', q.status === 'NEEDS_INFO' && q.messages.some((m) => m.authorRole === 'CHEF'), q.status);
  const reply = (await call('POST', `/chef-requests/${r1.id}/messages`, { body: 'Just a preference, thanks!' }, C)).json;
  check('the customer’s reply puts it back with the chef', reply.status === 'PENDING', reply.status);

  // quote v1 → revision → v2
  if (closedDay) {
    const qClosed = await call('POST', `/chef/requests/${r1.id}/quote`, quoteBody({ serviceDate: closedDay.date }), K);
    check('a quote can’t be for a day the chef isn’t cooking', qClosed.status === 400 && qClosed.json.code === 'QUOTE_DATE_UNAVAILABLE', qClosed.json);
  }
  const v1 = (await call('POST', `/chef/requests/${r1.id}/quote`, quoteBody(), K)).json;
  check('the chef quotes: exact changes, price per serving, allergens and date', v1.status === 'QUOTED' && v1.latestQuote?.version === 1 && v1.latestQuote.totalCents === 4200 && v1.latestQuote.allergens.includes('shellfish') && v1.latestQuote.serviceDate === day.date, v1.latestQuote);
  check('the quote is valid no later than the date’s order cutoff', new Date(v1.latestQuote.expiresAt) <= new Date(day.orderBy), { exp: v1.latestQuote.expiresAt, orderBy: day.orderBy });
  const rev = (await call('POST', `/chef-requests/${r1.id}/revise`, { note: 'Could you do it for $20 a bowl?' }, C)).json;
  check('the customer asks for a revision (back to the chef)', rev.status === 'PENDING' && rev.quotes[0].status === 'REVISION_REQUESTED', rev.quotes?.[0]?.status);
  const v2 = (await call('POST', `/chef/requests/${r1.id}/quote`, quoteBody({ unitPriceCents: 2000, note: 'Happy to do $20' }), K)).json;
  check('a revised quote is a new version', v2.latestQuote?.version === 2 && v2.quotes.length === 2 && v2.latestQuote.totalCents === 4000, v2.quotes?.map((x) => [x.version, x.status]));
  const notes = (await call('GET', '/me/notifications', undefined, C)).json;
  check('the customer is notified of the quote', Array.isArray(notes) && notes.some((n) => n.template === 'chef.request.quoted'), Array.isArray(notes) ? notes.map((n) => n.template).slice(0, 6) : notes);

  // accept → checkout at the quoted price
  const stale = await call('POST', `/chef-requests/${r1.id}/accept`, { quoteId: v1.latestQuote.id }, C);
  check('an old quote version can’t be accepted', stale.status === 409, stale.json);
  const acc = (await call('POST', `/chef-requests/${r1.id}/accept`, { quoteId: v2.latestQuote.id }, C)).json;
  const line = acc.cartLine;
  check('accepting returns a cart line priced from the quote (quantity and date fixed)', acc.request?.status === 'ACCEPTED' && line?.unitPriceCents === 2000 && line.quantity === 2 && line.serviceDate === day.date && line.chefRequestQuoteId === v2.latestQuote.id, line);
  const time = day.slots[0];
  const at = await isoAt(day.date, time);
  const qq = (lineOver = {}, scheduledFor = at, token = C) => call('POST', '/quotes', { locationId: spaghetti.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor, tipCents: 0, holdKey: globalThis.crypto.randomUUID(), lines: [{ menuItemId: line.menuItemId, quantity: line.quantity, modifierOptionIds: line.modifierOptionIds, chefRequestQuoteId: line.chefRequestQuoteId, ...lineOver }] }, token);
  const wrongQty = await qq({ quantity: 3 });
  check('the quoted quantity can’t be changed at checkout', wrongQty.status === 400 && wrongQty.json.code === 'CHEF_QUOTE_QUANTITY', wrongQty.json);
  if (otherDay) {
    const wrongDay = await qq({}, await isoAt(otherDay.date, otherDay.slots[0]));
    check('…nor the quoted day', wrongDay.status === 400 && wrongDay.json.code === 'CHEF_QUOTE_DATE', wrongDay.json);
  }
  const stolen = await qq({}, at, other);
  check('another customer can’t use the quote', stolen.status === 400 && stolen.json.code === 'CHEF_QUOTE_INVALID', stolen.json);
  const pq = await qq();
  check('checkout prices the line from the chef’s quote', pq.status === 201 && pq.json.subtotalCents === 4000 && /special request/.test(pq.json.lines[0].name) && pq.json.lines[0].chefRequestQuoteId === line.chefRequestQuoteId, pq.json);
  const order = (await call('POST', '/orders', { quoteId: pq.json.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  const ol = order.lines?.[0];
  check('the order carries the special request to the kitchen (changes and allergens)', order.prepaid === true && /Special request R-/.test(ol?.specialInstructions || '') && (ol?.allergens || []).includes('shellfish'), ol);
  const after = (await call('GET', `/chef-requests/${r1.id}`, undefined, C)).json;
  check('the request is marked ordered with its order', after.status === 'ORDERED' && after.orderId === order.id && after.quotes[0].status === 'ORDERED', { status: after.status, orderId: after.orderId });
  const reuse = await qq();
  check('an accepted quote is used once', reuse.status === 400 && reuse.json.code === 'CHEF_QUOTE_USED', reuse.json);
  await call('POST', `/orders/${order.id}/cancel`, { reason: 'smoke cleanup' }, C);

  // decline, withdraw
  const r2 = (await ask({ details: 'Can you make it gluten free?' })).json;
  const dec = (await call('POST', `/chef/requests/${r2.id}/decline`, { reason: 'My kitchen isn’t gluten-free' }, K)).json;
  check('the chef declines with a reason', dec.status === 'DECLINED' && !dec.can.accept, dec.status);
  const decMsg = await call('POST', `/chef-requests/${r2.id}/messages`, { body: 'ok' }, C);
  check('a closed request takes no more messages', decMsg.status === 409, decMsg.status);
  const r3 = (await ask({ details: 'Extra basil on top, please' })).json;
  const wd = (await call('POST', `/chef-requests/${r3.id}/withdraw`, { reason: 'Changed my mind' }, C)).json;
  check('the customer withdraws a request', wd.status === 'WITHDRAWN', wd.status);

  // deadlines
  const r4 = (await ask({ details: 'Half portion for a child, please' })).json;
  const r5 = (await ask({ details: 'Add roasted mushrooms, please' })).json;
  const v5 = (await call('POST', `/chef/requests/${r5.id}/quote`, quoteBody({ changes: 'Add roasted mushrooms', unitPriceCents: 1900, allergens: ['wheat', 'milk'], validHours: 1 }), K)).json;
  check('a quote can have a short validity', new Date(v5.latestQuote.expiresAt) - Date.now() <= 3_600_000 + 5_000, v5.latestQuote?.expiresAt);
  const job = (await call('POST', '/admin/jobs/chef-requests', { at: new Date(Date.now() + 2 * 3_600_000).toISOString() }, A)).json;
  const r4b = (await call('GET', `/chef-requests/${r4.id}`, undefined, C)).json;
  const r5b = (await call('GET', `/chef-requests/${r5.id}`, undefined, C)).json;
  check('an unaccepted quote expires', r5b.status === 'EXPIRED' && r5b.quotes[0].status === 'EXPIRED', { status: r5b.status, job });
  check('…while a request still inside the chef’s window stays open', r4b.status === 'PENDING', r4b.status);
  await call('POST', '/admin/jobs/chef-requests', { at: new Date(Date.now() + 25 * 3_600_000).toISOString() }, A);
  const r4c = (await call('GET', `/chef-requests/${r4.id}`, undefined, C)).json;
  check('a request the chef doesn’t answer in time expires', r4c.status === 'EXPIRED' && /didn’t answer/.test(r4c.messages.at(-1)?.body || ''), r4c.status);

  // Gutad staff supervision
  const r6 = (await ask({ details: 'Can it come with garlic bread?' })).json;
  const list = (await call('GET', '/admin/chef-requests?status=OPEN', undefined, A)).json;
  check('staff see open requests with response-time and acceptance stats', list.requests?.some((x) => x.id === r6.id) && typeof list.stats?.open === 'number' && list.stats.avgResponseMinutes !== undefined, list.stats);
  const staffView = (await call('GET', `/chef-requests/${r6.id}`, undefined, A)).json;
  check('staff can open any request (supervision)', staffView.viewerRole === 'STAFF' && staffView.can.close, staffView.viewerRole);
  const ext = (await call('POST', `/admin/chef-requests/${r6.id}/extend`, { hours: 12 }, A)).json;
  check('staff extend the chef’s deadline', new Date(ext.respondBy) - new Date(r6.respondBy) >= 12 * 3_600_000 - 5_000, { before: r6.respondBy, after: ext.respondBy });
  const cl = (await call('POST', `/admin/chef-requests/${r6.id}/close`, { reason: 'Duplicate of another request' }, A)).json;
  check('staff close a request', cl.status === 'CLOSED', cl.status);
  const custClose = await call('POST', `/admin/chef-requests/${r1.id}/close`, { reason: 'nope nope' }, C);
  check('customers can’t use staff actions', custClose.status === 403, custClose.status);
  const mine = (await call('GET', '/chef-requests', undefined, C)).json;
  check('My requests lists the customer’s requests with their latest quote', Array.isArray(mine) && mine.length >= 6 && mine.find((x) => x.id === r1.id)?.latestQuote?.version === 2, Array.isArray(mine) ? mine.length : mine);
}
