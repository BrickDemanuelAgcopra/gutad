import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { locations, notifications, orders, orgMemberships, outboxEvents, reservations, users, waitlistEntries } from '../../db/schema';
import { NotifyService } from '../../core/notify.service';
import { JwtPayload } from '../../common/auth';
import { render } from './templates';
import { Senders, type PushOptions } from './senders';

/**
 * 23 — turns domain events (outbox) into deduplicated, consent-aware notifications, then delivers them.
 * Both loops are idempotent and safe to run on multiple worker replicas (row-level claims).
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(@Inject(DB) private readonly db: Db, private readonly notify: NotifyService, private readonly senders: Senders) {}

  /** In-app inbox for the current user. */
  async inbox(user: JwtPayload) {
    return this.db.select({ id: notifications.id, template: notifications.template, payload: notifications.payload, createdAt: notifications.createdAt, status: notifications.status }).from(notifications).where(and(eq(notifications.userId, user.sub), eq(notifications.channel, 'IN_APP'))).orderBy(desc(notifications.createdAt)).limit(50);
  }

  /** Relay: claim unpublished outbox rows, fan out to notifications. */
  async relayOutbox(batch = 100): Promise<number> {
    const rows = await this.db.select().from(outboxEvents).where(and(isNull(outboxEvents.publishedAt), lt(outboxEvents.attempts, 10))).orderBy(asc(outboxEvents.createdAt)).limit(batch);
    let n = 0;
    for (const ev of rows) {
      try {
        await this.handle(ev.topic, ev.aggregateId, ev.payload as Record<string, unknown>);
        await this.db.update(outboxEvents).set({ publishedAt: new Date() }).where(eq(outboxEvents.id, ev.id));
        n++;
      } catch (e) {
        await this.db.update(outboxEvents).set({ attempts: ev.attempts + 1, lastError: (e as Error).message }).where(eq(outboxEvents.id, ev.id));
        this.log.warn(`outbox ${ev.id} (${ev.topic}) failed: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async handle(topic: string, aggregateId: string, payload: Record<string, unknown>) {
    // topic + aggregateId let the mobile app open the right screen when a push is tapped.
    const p: Record<string, unknown> = { ...payload, topic, aggregateId };
    if (!p.timezone) {
      const tz = await this.timezoneFor(topic, aggregateId, p).catch(() => null);
      if (tz) p.timezone = tz;
    }
    const userId = (p.userId as string) || null;
    const email = (p.email as string) || null;
    const phone = (p.phone as string) || null;
    const dedupe = `${topic}:${aggregateId}`;
    // a courier booking canceled as part of something the customer already hears about (order canceled, switched to pickup)
    if (topic === 'delivery.failed' && p.quiet) return;
    switch (topic) {
      case 'courier.offer': {
        if (p.userId) await this.notify.queue({ userId: p.userId as string, template: 'courier.offer', payload: p, dedupeKey: `${dedupe}:${p.userId}:${p.expiresAt}`, channels: ['PUSH'] });
        return;
      }
      case 'order.delivery_choice': {
        // no courier: the customer switched to pickup (or canceled, which order.canceled already tells them)
        if (p.choice === 'PICKUP') {
          const target = await this.resolveTarget(topic, aggregateId, userId, email, phone, p);
          if (target.userId || target.email || target.phone) await this.notify.queue({ ...target, template: 'order.switched_to_pickup', payload: p, dedupeKey: dedupe });
        }
        await this.notifyMerchantStaff(p.locationId as string, 'merchant.delivery_choice', p, dedupe);
        return;
      }
      case 'order.submitted': {
        if (userId) await this.notify.queue({ userId, template: topic, payload: p, dedupeKey: dedupe });
        await this.notifyMerchantStaff(p.locationId as string, 'merchant.new_order', p, dedupe);
        return;
      }
      case 'order.accepted':
      case 'order.rejected':
      case 'order.ready':
      case 'order.pickup_reminder':
      case 'recall.notice':
      case 'order.collected':
      case 'order.completed':
      case 'order.canceled':
      case 'order.line_unavailable':
      case 'payment.refunded':
      case 'delivery.assigned':
      case 'delivery.picked_up':
      case 'delivery.delivered':
      case 'delivery.failed':
      case 'delivery.no_courier':
      case 'delivery.arrived':
      case 'delivery.attempt':
      case 'ticket.confirmed':
      case 'reservation.held':
      case 'reservation.confirmed':
      case 'reservation.reminder':
      case 'reservation.canceled':
      case 'reservation.no_show':
      case 'waitlist.table_ready':
      case 'waitlist.expired':
      case 'event.proposal_sent':
      case 'shipment.shipped':
      case 'membership.renewal_failed':
      case 'giftcard.delivered':
      case 'referral.rewarded':
      case 'challenge.completed':
      case 'incident.resolved': {
        const target = await this.resolveTarget(topic, aggregateId, userId, email, phone, p);
        if (target.userId || target.email || target.phone) await this.notify.queue({ ...target, template: topic, payload: p, dedupeKey: dedupe });
        return;
      }
      case 'delivery.late': {
        const target = await this.resolveTarget(topic, aggregateId, userId, email, phone, p);
        if (target.userId || target.email) await this.notify.queue({ ...target, template: p.kind === 'order' ? 'order.time_adjusted' : 'delivery.late', payload: p, dedupeKey: `${dedupe}:${p.promiseAt || ''}` });
        return;
      }
      case 'group_order.cutoff':
        if (p.organizerUserId) await this.notify.queue({ userId: p.organizerUserId as string, template: topic, payload: p, dedupeKey: dedupe });
        return;
      case 'payout.paid':
      case 'payout.failed':
        if (p.organizationId) await this.notifyOrgOwners(p.organizationId as string, topic, p, dedupe);
        return;
      case 'integration.failed': {
        if (p.kind === 'order.unacknowledged') {
          const d = `${dedupe}:${Math.floor(Date.now() / 600_000)}`;
          await this.notifyMerchantStaff(p.locationId as string, 'merchant.unacknowledged', p, d, true);
          // the tablet may be unattended: reach the owners on their own phone and inbox too
          await this.notifyLocationOwners(p.locationId as string, 'merchant.unacknowledged', p, `${d}:owner`, ['SMS', 'EMAIL']);
        }
        return;
      }
      default:
        return; // audit-only topics (reservation.seated, payment.captured, delivery.requested, …)
    }
  }

  /** The location's IANA zone, so emails show local times: from locationId, the order, or the reservation/waitlist entry. */
  private async timezoneFor(topic: string, aggregateId: string, p: Record<string, unknown>): Promise<string | null> {
    let locationId = (p.locationId as string) || null;
    const orderId = (p.orderId as string) || (topic.startsWith('order.') ? aggregateId : null);
    if (!locationId && orderId) [{ locationId = null } = {}] = await this.db.select({ locationId: orders.locationId }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!locationId && topic.startsWith('reservation.')) [{ locationId = null } = {}] = await this.db.select({ locationId: reservations.locationId }).from(reservations).where(eq(reservations.id, aggregateId)).limit(1);
    if (!locationId && topic.startsWith('waitlist.')) [{ locationId = null } = {}] = await this.db.select({ locationId: waitlistEntries.locationId }).from(waitlistEntries).where(eq(waitlistEntries.id, aggregateId)).limit(1);
    if (!locationId) return null;
    const [loc] = await this.db.select({ timezone: locations.timezone }).from(locations).where(eq(locations.id, locationId)).limit(1);
    return loc?.timezone || null;
  }

  private async resolveTarget(topic: string, aggregateId: string, userId: string | null, email: string | null, phone: string | null, p: Record<string, unknown>) {
    if (userId || email || phone) return { userId, email, phone };
    // fall back to the order's guest contact when the event carries only an order id
    const orderId = (p.orderId as string) || (topic.startsWith('order.') ? aggregateId : null);
    if (orderId) {
      const [o] = await this.db.select({ userId: orders.userId, guestEmail: orders.guestEmail, guestPhone: orders.guestPhone }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (o) return { userId: o.userId, email: o.guestEmail, phone: o.guestPhone };
    }
    return { userId: null, email: null, phone: null };
  }

  private async notifyMerchantStaff(locationId: string, template: string, p: Record<string, unknown>, dedupe: string, includeFallbackPhone = false) {
    if (!locationId) return;
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) return;
    const members = await this.db.select({ userId: orgMemberships.userId, locationIds: orgMemberships.locationIds }).from(orgMemberships).where(eq(orgMemberships.organizationId, loc.organizationId));
    for (const m of members) {
      if (m.locationIds.length && !m.locationIds.includes(locationId)) continue;
      await this.notify.queue({ userId: m.userId, template, payload: p, dedupeKey: `${dedupe}:${m.userId}`, channels: ['PUSH', 'IN_APP'] });
    }
    if (includeFallbackPhone && loc.tabletFallbackPhone) await this.notify.queue({ phone: loc.tabletFallbackPhone, template, payload: p, dedupeKey: `${dedupe}:fallback`, channels: ['SMS'] });
  }

  /** Owners of the location's organization (respecting per-location memberships) on the given channels. */
  private async notifyLocationOwners(locationId: string, template: string, p: Record<string, unknown>, dedupe: string, channels: ('SMS' | 'EMAIL' | 'PUSH')[]) {
    if (!locationId) return;
    const [loc] = await this.db.select({ orgId: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) return;
    const owners = await this.db.select({ userId: orgMemberships.userId, locationIds: orgMemberships.locationIds }).from(orgMemberships).where(and(eq(orgMemberships.organizationId, loc.orgId), eq(orgMemberships.role, 'MERCHANT_OWNER')));
    for (const o of owners) {
      if (o.locationIds.length && !o.locationIds.includes(locationId)) continue;
      await this.notify.queue({ userId: o.userId, template, payload: p, dedupeKey: `${dedupe}:${o.userId}`, channels });
    }
  }

  private async notifyOrgOwners(orgId: string, template: string, p: Record<string, unknown>, dedupe: string) {
    const owners = await this.db.select({ userId: orgMemberships.userId }).from(orgMemberships).where(and(eq(orgMemberships.organizationId, orgId), eq(orgMemberships.role, 'MERCHANT_OWNER')));
    for (const o of owners) await this.notify.queue({ userId: o.userId, template, payload: p, dedupeKey: `${dedupe}:${o.userId}`, channels: ['EMAIL', 'IN_APP'] });
  }

  /** Delivery loop: send QUEUED notifications; IN_APP rows are "sent" immediately. */
  async deliverQueued(batch = 100): Promise<number> {
    const rows = await this.db.select().from(notifications).where(eq(notifications.status, 'QUEUED')).orderBy(asc(notifications.createdAt)).limit(batch);
    let n = 0;
    for (const row of rows) {
      const [claimed] = await this.db.update(notifications).set({ status: 'SENDING' }).where(and(eq(notifications.id, row.id), eq(notifications.status, 'QUEUED'))).returning();
      if (!claimed) continue;
      try {
        const r = render(row.template, row.payload as Record<string, unknown>, { recipient: row.recipient });
        if (row.channel === 'EMAIL') await this.senders.email(row.recipient, r);
        else if (row.channel === 'SMS') await this.senders.sms(row.recipient, r);
        else if (row.channel === 'PUSH') await this.senders.push(row.recipient, r, { ...pushData(row.payload as Record<string, unknown>), ...(row.template.startsWith('merchant.') || row.template === 'courier.offer' ? { kind: row.template } : {}) }, pushOptions(row.template));
        await this.db.update(notifications).set({ status: 'SENT', sentAt: new Date() }).where(eq(notifications.id, row.id));
        n++;
      } catch (e) {
        await this.db.update(notifications).set({ status: 'FAILED', error: (e as Error).message }).where(eq(notifications.id, row.id));
      }
    }
    return n;
  }

  async retryFailed() {
    const r = await this.db.update(notifications).set({ status: 'QUEUED', error: null }).where(and(eq(notifications.status, 'FAILED'), sql`${notifications.createdAt} > now() - interval '1 day'`)).returning({ id: notifications.id });
    return r.length;
  }

  async markRead(user: JwtPayload, id: string) {
    await this.db.update(notifications).set({ status: 'READ' }).where(and(eq(notifications.id, id), eq(notifications.userId, user.sub)));
    return { ok: true };
  }

  async unreadCount(user: JwtPayload) {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, user.sub), eq(notifications.channel, 'IN_APP'), sql`${notifications.status} <> 'READ'`));
    return { unread: r?.n || 0 };
  }

  async usersWithPush() {
    return this.db.select({ id: users.id }).from(users).where(sql`cardinality(${users.pushTokens}) > 0`).limit(1);
  }
}

/**
 * Push data is visible to Expo/APNs/FCM and on the lock screen's payload, so send only what the app
 * needs to navigate — never the full event payload (which can hold emails, phones and user ids).
 */
/** New and unanswered orders ring on the app's loud "orders" channel (Android) with the order sound (iOS). */
export function pushOptions(template: string): PushOptions | undefined {
  if (template === 'merchant.new_order' || template === 'merchant.unacknowledged') return { channelId: 'orders', sound: 'new_order.wav', priority: 'high' };
  if (template === 'courier.offer') return { channelId: 'offers', sound: 'new_order.wav', priority: 'high' };
  return undefined;
}

export function pushData(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['topic', 'aggregateId', 'orderId', 'confirmationCode', 'number']) {
    const v = payload?.[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}
