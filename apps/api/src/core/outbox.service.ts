import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, DbOrTx } from '../db/db.module';
import { outboxEvents } from '../db/schema';

export type DomainTopic =
  | 'order.submitted'
  | 'order.accepted'
  | 'order.rejected'
  | 'order.ready'
  | 'order.pickup_reminder'
  | 'recall.notice'
  | 'order.collected'
  | 'order.completed'
  | 'order.canceled'
  | 'order.line_unavailable'
  | 'order.delivery_choice'
  | 'order.priority_refunded'
  | 'payment.captured'
  | 'payment.refunded'
  | 'payment.disputed'
  | 'delivery.requested'
  | 'delivery.assigned'
  | 'delivery.picked_up'
  | 'delivery.delivered'
  | 'delivery.failed'
  | 'delivery.no_courier'
  | 'delivery.late'
  | 'delivery.arrived'
  | 'delivery.attempt'
  | 'delivery.issue'
  | 'courier.decision'
  | 'courier.offer'
  | 'reservation.held'
  | 'reservation.confirmed'
  | 'reservation.reminder'
  | 'reservation.canceled'
  | 'reservation.no_show'
  | 'reservation.seated'
  | 'waitlist.table_ready'
  | 'waitlist.expired'
  | 'ticket.confirmed'
  | 'event.proposal_sent'
  | 'group_order.cutoff'
  | 'shipment.shipped'
  | 'payout.paid'
  | 'payout.failed'
  | 'membership.renewal_failed'
  | 'giftcard.delivered'
  | 'referral.rewarded'
  | 'challenge.completed'
  | 'integration.failed'
  | 'incident.resolved'
  | 'chef_request.created'
  | 'chef_request.quoted'
  | 'chef_request.accepted'
  | 'chef_request.declined'
  | 'chef_request.expired'
  | 'chef_request.ordered';

/** Writes domain events in the same transaction as business state; the worker relays them. */
@Injectable()
export class OutboxService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async publish(topic: DomainTopic, aggregateId: string, payload: Record<string, unknown>, tx: DbOrTx = this.db) {
    await tx.insert(outboxEvents).values({ topic, aggregateId, payload });
  }
}
