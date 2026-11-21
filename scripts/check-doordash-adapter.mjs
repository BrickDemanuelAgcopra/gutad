// Courier R2: DoorDash Drive adapter checks against a stubbed fetch (no network, no credentials).
// Run after `nest build`: node scripts/check-doordash-adapter.mjs
import { createRequire } from 'node:module';

process.env.DATABASE_URL ||= 'postgresql://unused@localhost/unused';
process.env.JWT_SECRET ||= 'adapter-check-secret-0123456789';
process.env.DOORDASH_DEVELOPER_ID = 'dev-id';
process.env.DOORDASH_KEY_ID = 'key-id';
process.env.DOORDASH_SIGNING_SECRET = Buffer.from('signing-secret').toString('base64url');
process.env.DOORDASH_WEBHOOK_SECRET = 'Basic c21va2U6c2VjcmV0';

const require = createRequire(import.meta.url);
const { DoorDashDriveProvider } = require('../apps/api/dist/modules/delivery/providers/doordash-drive.provider.js');
const { WebhookAuthError } = require('../apps/api/dist/modules/delivery/providers/delivery-provider.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); } };
const calls = [];
const respond = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const dd = new DoorDashDriveProvider();
let next = [];
dd.fetchImpl = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return next.shift() ?? respond(500, { message: 'no stub' }); };

const pickup = { line1: '400 W 14th St', city: 'New York', region: 'NY', postalCode: '10014', contactName: 'Demo Kitchen', contactPhone: '(212) 555-0100', instructions: 'Courier door on the left' };
const dropoff = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048, contactName: 'Sam', instructions: 'Buzz 4B' };
const readyAt = new Date(Date.now() + 20 * 60_000);

console.log('DoorDash Drive adapter');
// create: direct POST /deliveries with items, alcohol, pickup time, instructions; JWT header
next = [respond(200, { external_delivery_id: 'job-1', delivery_status: 'created', fee: 975, tracking_url: 'https://track/1' })];
const created = await dd.createJob({ externalId: 'job-1', pickup, dropoff, orderValueCents: 4200, tipCents: 300, providerQuoteId: 'old-quote', idempotencyKey: 'dispatch:job-1', pickupReadyAt: readyAt, items: [{ name: 'Smash Society: Double smash', quantity: 1 }], containsAlcohol: true });
const c0 = calls[0];
const jwt = c0.init.headers.Authorization.replace('Bearer ', '').split('.');
const hdr = JSON.parse(Buffer.from(jwt[0], 'base64url').toString());
check('creates the delivery directly under our job id (no stale quote accept)', c0.url.endsWith('/drive/v2/deliveries') && c0.init.method === 'POST' && c0.body.external_delivery_id === 'job-1', c0.url);
check('sends items, the alcohol flag, pickup time, instructions, dropoff location, E.164 phones', c0.body.items?.[0]?.name === 'Smash Society: Double smash' && c0.body.order_contains?.alcohol === true && c0.body.pickup_time === readyAt.toISOString() && c0.body.pickup_instructions === 'Courier door on the left' && c0.body.dropoff_instructions === 'Buzz 4B' && c0.body.dropoff_location?.lat === 40.7425 && c0.body.pickup_phone_number === '+12125550100' && c0.body.action_if_undeliverable === 'return_to_pickup', c0.body);
check('signs a DD-JWT-V1 token', hdr.alg === 'HS256' && hdr['dd-ver'] === 'DD-JWT-V1' && jwt.length === 3, hdr);
check('reads back status, tracking and the fee', created.status === 'REQUESTED' && created.trackingUrl === 'https://track/1' && created.feeCents === 975, created);

// 409 duplicate → look the delivery up instead of failing
calls.length = 0;
next = [respond(409, { code: 'duplicate_delivery_id' }), respond(200, { external_delivery_id: 'job-1', delivery_status: 'enroute_to_pickup', fee: 975 })];
const dup = await dd.createJob({ externalId: 'job-1', pickup, dropoff, orderValueCents: 4200, providerQuoteId: null, idempotencyKey: 'x' });
check('a 409 (lost response, already created) returns the existing delivery', dup.status === 'ASSIGNED' && calls[1]?.init.method === 'GET' && calls[1].url.endsWith('/drive/v2/deliveries/job-1'), { dup, calls: calls.map((c) => c.init.method) });

// other errors still throw
next = [respond(422, { message: 'bad address' })];
let threw = false;
try { await dd.createJob({ externalId: 'job-2', pickup, dropoff, orderValueCents: 1, providerQuoteId: null, idempotencyKey: 'y' }); } catch { threw = true; }
check('other API errors surface (so dispatch can fail over)', threw);

// ready-time update
calls.length = 0;
next = [respond(200, {})];
const later = new Date(Date.now() + 35 * 60_000);
const upd = await dd.updatePickupTime('job-1', later);
check('pickup time moves with PATCH /deliveries/{id}', upd.ok && calls[0].init.method === 'PATCH' && calls[0].body.pickup_time === later.toISOString(), calls[0]);

// cancellation fee
next = [respond(200, { external_delivery_id: 'job-1', delivery_status: 'cancelled', cancellation_fee: 450 })];
const can = await dd.cancel('job-1');
check('cancel reports the cancellation fee', can.ok && can.feeCents === 450, can);

// webhooks
const body = (o) => Buffer.from(JSON.stringify(o));
let rejected = false;
try { await dd.parseWebhook(body({ external_delivery_id: 'job-1', delivery_status: 'delivered' }), { authorization: 'Basic wrong' }); } catch (e) { rejected = e instanceof WebhookAuthError; }
let missing = false;
try { await dd.parseWebhook(body({ external_delivery_id: 'job-1', delivery_status: 'delivered' }), {}); } catch (e) { missing = e instanceof WebhookAuthError; }
check('webhooks without the configured Authorization value are rejected', rejected && missing);
const auth = { authorization: 'Basic c21va2U6c2VjcmV0' };
const ret = await dd.parseWebhook(body({ event_name: 'DELIVERY_RETURNED', external_delivery_id: 'job-1', delivery_status: 'returned', created_at: '2026-11-21T10:00:00Z', fee: 1010 }), auth);
const back = await dd.parseWebhook(body({ event_name: 'DELIVERY_RETURN_INITIALIZED', external_delivery_id: 'job-1', delivery_status: 'enroute_to_return', created_at: '2026-11-21T09:50:00Z' }), auth);
const evOnly = await dd.parseWebhook(body({ event_name: 'DASHER_PICKED_UP', external_delivery_id: 'job-1', created_at: '2026-11-21T09:30:00Z', dasher_location: { lat: 40.74, lng: -74.0 }, dasher_name: 'Ana' }), auth);
const unknown = await dd.parseWebhook(body({ event_name: 'SOMETHING_NEW', external_delivery_id: 'job-1', delivery_status: 'mystery' }), auth);
check('returns map to RETURNED (the return leg stays PICKED_UP); fees come with events', ret.status === 'RETURNED' && ret.feeCents === 1010 && back.status === 'PICKED_UP', { ret: ret.status, back: back.status });
check('event-only payloads map by event name, with dasher location and name', evOnly.status === 'PICKED_UP' && evOnly.lat === 40.74 && evOnly.driverName === 'Ana', evOnly);
check('unknown statuses never fail a job (recorded as informational)', unknown.status === 'REQUESTED', unknown.status);
check('event ids are stable per event for de-duplication', ret.id === (await dd.parseWebhook(body({ event_name: 'DELIVERY_RETURNED', external_delivery_id: 'job-1', delivery_status: 'returned', created_at: '2026-11-21T10:00:00Z' }), auth)).id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
