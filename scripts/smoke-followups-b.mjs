// Follow-ups B: restaurant auto-throttle (13.7-L), network ticket printers (13.8-P), kiosk mode (14.8-K), road travel
// times (15.3-R), courier document upload (16.2-U), live map push (17.1-R), two partner providers with failover (17.9-M).
export async function followupsB({ call, check, A, O, C, locId, demoOrgId, owner, API }) {
  console.log('\n── Follow-ups B: capacity, printers, kiosk, routing, courier files, live map, partner failover');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = (await call('GET', `/public/locations/${locId}/menus?channel=MARKETPLACE`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const pickupQuote = (extra = {}) => call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }], ...extra }, C);
  const place = async () => { const q = (await pickupQuote()).json; return (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json; };
  // clean up an order whatever state it reached (the demo bistro may auto-accept)
  const drop = async (o) => { if (!o?.id) return; const r = await call('POST', `/orders/${o.id}/reject`, { reason: 'Smoke follow-ups B cleanup' }, O); if (r.status >= 400) await call('POST', `/orders/${o.id}/staff-cancel`, { reason: 'Smoke follow-ups B cleanup', funder: 'MERCHANT' }, A); };
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const D = (await login('driver@demo.gutad.io', 'driver12345')).accessToken;
  void demoOrgId; void owner;

  // ── 13.7-L auto-throttle for a restaurant without a production kitchen
  const l0 = (await call('GET', `/locations/${locId}/load`, undefined, O)).json;
  const n = l0.openOrders ?? 0;
  const custSet = await call('PATCH', `/locations/${locId}/load-settings`, { enabled: true }, C);
  await call('PATCH', `/locations/${locId}/load-settings`, { enabled: true, busyAtOpenOrders: n + 1, overloadAtOpenOrders: n + 2, busyExtraMinutes: 12, busyAtBacklogMinutes: null, overloadAtBacklogMinutes: null, parallelOrders: 3 }, O);
  const qNormal = (await pickupQuote()).json;
  const o1 = await place();
  const qBusy = (await pickupQuote()).json;
  const o2 = await place();
  const qOver = await pickupQuote();
  const qSched = await pickupQuote({ scheduledFor: new Date(Date.now() + 3 * 3600_000).toISOString() });
  const l1 = (await call('GET', `/locations/${locId}/load`, undefined, O)).json;
  await call('PATCH', `/locations/${locId}/load-settings`, { enabled: false }, O);
  const qAfter = await pickupQuote();
  await drop(o1); await drop(o2);
  check('13.7-L restaurant load (open orders) is measured; managers set thresholds', l0.hasKitchen === false && typeof l0.openOrders === 'number' && typeof l0.backlogMinutes === 'number' && custSet.status === 403 && l1.openOrders >= n + 2 && l1.level === 'OVERLOADED', { l0, l1, custSet: custSet.status });
  check('13.7-L busy adds prep minutes; at capacity ASAP orders stop, scheduled still allowed; off again → normal', Array.isArray(qNormal.warnings) && !qNormal.warnings.some((w) => /busy/i.test(w)) && qBusy.warnings?.some((w) => /busy/i.test(w)) && new Date(qBusy.promiseAt) - new Date(qNormal.promiseAt) >= 10 * 60_000 && qOver.status === 400 && qOver.json.code === 'KITCHEN_BUSY' && qSched.status === 201 && qAfter.status === 201, { normal: qNormal.promiseAt, busy: qBusy.promiseAt, warnings: qBusy.warnings, over: qOver.json, sched: qSched.status, after: qAfter.status });

  // ── 13.8-P network ticket printers (LOG adapter only: no sockets are opened)
  const badHost = await call('POST', `/locations/${locId}/printers`, { name: 'Bad host', protocol: 'RAW_TCP', host: 'not a host!' }, O);
  const pr = (await call('POST', `/locations/${locId}/printers`, { name: `Pass ${stamp}`, role: 'BOTH', protocol: 'LOG', autoPrint: true, width: 42 }, O)).json;
  const custPrinters = await call('GET', `/locations/${locId}/printers`, undefined, C);
  const test = (await call('POST', `/printers/${pr.id}/test`, {}, O)).json;
  check('13.8-P printer registry per location, validated, test print sent', badHost.status === 400 && pr.id && pr.protocol === 'LOG' && custPrinters.status === 403 && test.status === 'PRINTED' && test.kind === 'TEST', { badHost: badHost.status, test });
  const o3 = await place();
  await call('POST', `/orders/${o3.id}/accept`, {}, O);
  const queued = (await call('GET', `/locations/${locId}/print-jobs`, undefined, O)).json.filter((j) => j.orderId === o3.id && j.kind === 'STATION_TICKET');
  const sweep = (await call('POST', '/admin/jobs/print-queue', {}, A)).json;
  const printed = (await call('GET', `/locations/${locId}/print-jobs`, undefined, O)).json.filter((j) => j.orderId === o3.id && j.kind === 'STATION_TICKET');
  check('13.8-P accepted orders queue station tickets for auto-print printers; the queue sends them', queued.length >= 1 && typeof sweep.due === 'number' && printed.length >= 1 && printed.every((j) => j.status === 'PRINTED') && /#/.test(printed[0].preview), { queued: queued.map((j) => j.status), printed: printed.map((j) => j.status), sweep });
  const manual = (await call('POST', `/orders/${o3.id}/print-tickets`, {}, O)).json;
  const pack = (await call('GET', `/locations/${locId}/packing`, undefined, O)).json;
  const task = Array.isArray(pack) ? pack.find((p) => p.orderId === o3.id) : null;
  const labels = task ? (await call('POST', `/packing/${task.id}/print-labels`, {}, O)).json : null;
  check('13.8-P print buttons: order tickets and bag labels go to the printer', Array.isArray(manual) && manual.length >= 1 && manual.every((j) => j.status === 'PRINTED') && Array.isArray(labels) && labels.length >= 1 && labels[0].kind === 'BAG_LABEL' && labels[0].status === 'PRINTED', { manual, labels, task: !!task });
  await call('PATCH', `/printers/${pr.id}`, { isActive: false }, O);
  const off = (await call('POST', `/printers/${pr.id}/test`, {}, O)).json;
  await call('PATCH', `/printers/${pr.id}`, { isActive: true }, O);
  const retried = (await call('POST', `/print-jobs/${off.id}/retry`, {}, O)).json;
  const jobsNow = (await call('GET', `/locations/${locId}/print-jobs?status=FAILED`, undefined, O)).json;
  check('13.8-P failure status and retry', off.status === 'FAILED' && /turned off/i.test(off.lastError || '') && retried.status === 'PRINTED' && retried.attempts === 1 && !jobsNow.some((j) => j.id === off.id), { off, retried });
  await call('DELETE', `/printers/${pr.id}`, undefined, O);
  await drop(o3);

  // ── 14.8-K kiosk: guest (no session) order on the KIOSK channel keeps its pager number
  await call('PATCH', `/locations/${locId}`, { acceptsKiosk: true }, O);
  const kq = await call('POST', '/quotes', { locationId: locId, channel: 'KIOSK', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 2 }] });
  const ko = await call('POST', '/orders', { quoteId: kq.json.id, guest: { name: 'Kiosk Kim', email: `kiosk-${stamp}@kiosk.gutad.io` }, tableNumber: '42', specialInstructions: 'PAY AT COUNTER (kiosk)' }, undefined, idem());
  check('14.8-K kiosk order: KIOSK channel, guest checkout, pager number kept on take-away', kq.status === 201 && kq.json.channel === 'KIOSK' && ko.status === 201 && ko.json.channel === 'KIOSK' && ko.json.tableNumber === '42' && !ko.json.userId, { kq: kq.status, ko: ko.json });
  await drop(ko.json);

  // ── 15.3-R routing provider (default: straight-line × minutes per km, no network)
  const rs = (await call('GET', '/admin/delivery/routing', undefined, A)).json;
  const rt = (await call('POST', '/admin/delivery/routing/test', { from: { lat: 40.7339, lng: -73.9921 }, to: { lat: 40.7346, lng: -73.9975 }, minutesPerKm: 4 }, A)).json;
  const rtCust = await call('POST', '/admin/delivery/routing/test', { from: { lat: 40.7339, lng: -73.9921 }, to: { lat: 40.7346, lng: -73.9975 } }, C);
  check('15.3-R travel time adapter: straight-line default, provider selectable by env', ['straight', 'osrm', 'google', 'mapbox'].includes(rs.provider) && rt.km > 0 && rt.minutes > 0 && (rs.provider !== 'straight' || (rt.source === 'straight' && Math.abs(rt.minutes - rt.km * 4) < 0.2)) && rtCust.status === 403, { rs, rt });

  // ── 16.2-U courier document upload to storage, served only to the courier and delivery staff
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const up = async (token, body, type, kind = 'INSURANCE') => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('expiresAt', new Date(Date.now() + 300 * 86400_000).toISOString());
    fd.append('file', new Blob([body], { type }), 'insurance.pdf');
    const res = await fetch(`${API}/driver/documents/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const doc = await up(D, pdf, 'application/pdf');
  const fake = await up(D, Buffer.from('not really a pdf'), 'application/pdf');
  const get = async (token) => { const r = await fetch(`${API}/files/${doc.json.fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: r.status, text: r.ok ? await r.text() : '' }; };
  const own = await get(D);
  const staff = await get(A);
  const cust = await get(C);
  const anon = await get(null);
  const dq = (await call('GET', '/admin/couriers/documents', undefined, A)).json;
  const inQueue = dq.pending?.find((x) => x.id === doc.json.id);
  check('16.2-U courier uploads a document file; type is checked; the queue links the stored file', doc.status === 201 && doc.json.fileId && doc.json.fileUrl === `/files/${doc.json.fileId}` && fake.status === 400 && inQueue?.fileId === doc.json.fileId, { doc: doc.json, fake: fake.json });
  check('16.2-U files are served to the courier and delivery staff only', own.status === 200 && own.text.startsWith('%PDF') && staff.status === 200 && cust.status === 403 && anon.status === 401, { own: own.status, staff: staff.status, cust: cust.status, anon: anon.status });
  const link = (await call('GET', `/files/${doc.json.fileId}/link`, undefined, A)).json;
  const lu = link.url ? new URL(link.url) : null;
  const viaLink = lu ? await fetch(`${API}${lu.pathname}${lu.search}`) : null;
  const tampered = lu ? await fetch(`${API}${lu.pathname}${lu.search.replace('sig=', 'sig=zz')}`) : null;
  const custLink = await call('GET', `/files/${doc.json.fileId}/link`, undefined, C);
  check('16.2-U short-lived signed links open the file in a browser (mobile review); forged links fail', viaLink?.status === 200 && tampered?.status === 403 && custLink.status === 403, { link, via: viaLink?.status, tampered: tampered?.status, cust: custLink.status });
  if (inQueue) await call('POST', `/admin/courier-documents/${inQueue.id}/review`, { approve: false, note: 'Smoke follow-ups B cleanup' }, A);

  // ── 17.1-R live map push over server-sent events
  const openStream = async (qs) => {
    const ctl = new AbortController();
    const res = await fetch(`${API}/live/delivery?${qs}`, { signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
    if (res.status !== 200) { await res.text().catch(() => ''); return { status: res.status, close: () => undefined }; }
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) {
            const ev = /^event: (.+)$/m.exec(p)?.[1];
            const data = /^data: (.+)$/m.exec(p)?.[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch { /* aborted */ }
    })();
    const waitFor = async (pred, ms = 6000) => { const until = Date.now() + ms; while (Date.now() < until) { const hit = events.find(pred); if (hit) return hit; await sleep(100); } return null; };
    return { status: 200, events, waitFor, close: () => ctl.abort() };
  };
  const noAuth = await openStream('');
  const custLive = await openStream(`token=${encodeURIComponent(C)}&locationId=${locId}`);
  const adminLive = await openStream(`token=${encodeURIComponent(A)}`);
  const merchLive = await openStream(`token=${encodeURIComponent(O)}&locationId=${locId}`);
  const me = (await call('GET', '/driver/me', undefined, D)).json;
  const readyA = adminLive.status === 200 ? await adminLive.waitFor((e) => e.event === 'ready') : null;
  const readyM = merchLive.status === 200 ? await merchLive.waitFor((e) => e.event === 'ready') : null;
  await call('POST', '/driver/location', { lat: 40.7351, lng: -73.9931 }, D);
  const pushed = adminLive.status === 200 ? await adminLive.waitFor((e) => e.event === 'courier' && e.data?.driverId === me.id) : null;
  adminLive.close(); merchLive.close(); custLive.close(); noAuth.close();
  check('17.1-R live stream needs a token and location access', noAuth.status === 401 && custLive.status === 403 && merchLive.status === 200 && !!readyM, { noAuth: noAuth.status, cust: custLive.status, merch: merchLive.status });
  check('17.1-R courier position is pushed to the admin live map', !!readyA && pushed?.data?.lat === 40.7351 && pushed?.data?.lng === -73.9931, { readyA: !!readyA, pushed });

  // ── 17.9-M two partner providers with priority and failover between them
  const names = (await call('GET', '/admin/delivery/provider-names', undefined, A)).json;
  const before = (await call('GET', '/admin/delivery/providers', undefined, A)).json;
  const active = before.filter((p) => p.isActive);
  for (const p of active) await call('POST', '/admin/delivery/providers', { id: p.id, regionId: p.regionId, provider: p.provider, priority: p.priority, isActive: false }, A);
  const pDown = (await call('POST', '/admin/delivery/providers', { regionId: null, provider: 'mock-down', priority: 1 }, A)).json;
  const pB = (await call('POST', '/admin/delivery/providers', { regionId: null, provider: 'mock-b', priority: 2 }, A)).json;
  const addr = { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975 };
  const deliver = async () => {
    const q = (await call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: lemonade.id, quantity: 4 }], deliveryAddress: addr, tipCents: 200 }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
    await call('POST', `/orders/${o.id}/accept`, {}, O);
    return o;
  };
  const oF = await deliver();
  const jF = (await call('GET', `/orders/${oF.id}`, undefined, C)).json.delivery;
  const liveF = (await call('GET', '/admin/delivery/live', undefined, A)).json.deliveries.find((d) => d.orderId === oF.id);
  const trackF = jF ? (await call('GET', `/public/delivery/${jF.id}/track`)).json : null;
  check('17.9-M first partner fails to dispatch → the next configured partner takes the job', names.available?.includes('mock-b') && names.available?.includes('mock-down') && jF?.fleet === 'PARTNER' && ['REQUESTED', 'ASSIGNED'].includes(jF.status) && liveF?.provider === 'mock-b' && trackF?.events?.some((e) => e.type === 'DISPATCH_FAILED') && trackF.events.some((e) => e.type === 'FAILOVER'), { jF, provider: liveF?.provider, events: trackF?.events?.map((e) => e.type) });
  await call('POST', '/admin/delivery/providers', { id: pB.id, regionId: null, provider: 'mock-b', priority: 2, isActive: false }, A);
  const oX = await deliver();
  const jX = (await call('GET', `/orders/${oX.id}`, undefined, C)).json.delivery;
  const trackX = jX ? (await call('GET', `/public/delivery/${jX.id}/track`)).json : null;
  check('17.9-M with no partner left the job waits for a dispatcher (unassigned + alert)', jX?.status === 'UNASSIGNED' && trackX?.events?.some((e) => e.type === 'DISPATCH_EXHAUSTED'), { jX, events: trackX?.events?.map((e) => e.type) });
  // restore the provider table as it was
  await call('POST', '/admin/delivery/providers', { id: pDown.id, regionId: null, provider: 'mock-down', priority: 1, isActive: false }, A);
  for (const p of active) await call('POST', '/admin/delivery/providers', { id: p.id, regionId: p.regionId, provider: p.provider, priority: p.priority, isActive: true }, A);
  for (const j of [jF, jX]) if (j?.id) await call('POST', `/delivery-jobs/${j.id}/cancel`, { reason: 'Smoke follow-ups B cleanup', costOwner: 'PLATFORM' }, O);
}
