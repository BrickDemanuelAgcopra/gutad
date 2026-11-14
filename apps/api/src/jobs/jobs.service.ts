import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { RedisService } from '../core/redis.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { KitchenService } from '../modules/kitchen/kitchen.service';
import { OrdersService } from '../modules/orders/orders.service';
import { DeliveryService } from '../modules/delivery/delivery.service';
import { ReservationsService } from '../modules/reservations/reservations.service';
import { EventsService } from '../modules/events/events.service';
import { GrowthService } from '../modules/growth/growth.service';
import { ContractsService } from '../modules/contracts/contracts.service';
import { SettlementService } from '../modules/settlement/settlement.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { GroupOrdersService } from '../modules/programs/group-orders.service';
import { ProgramsService } from '../modules/programs/programs.service';
import { addDays } from '../common/utils';
import { ApprovalsService } from '../modules/security/approvals.service';
import { AlertsService } from '../modules/ops/alerts.service';
import { LocationsAdminService } from '../modules/merchant-admin/locations-admin.service';
import { MerchantsAdminService } from '../modules/merchant-admin/merchants-admin.service';
import { BrandsAdminService } from '../modules/merchant-admin/brands-admin.service';
import { MenuAdminService } from '../modules/catalog/menu-admin.service';
import { CustomersService } from '../modules/customers/customers.service';
import { SupportService } from '../modules/support/support.service';

/**
 * Background jobs. Every job takes a Redis lock so several worker replicas never double-run,
 * and every underlying service method is idempotent so a crash mid-run is safe to retry.
 */
@Injectable()
export class JobsService {
  private readonly log = new Logger('Jobs');

  constructor(
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    private readonly kitchen: KitchenService,
    private readonly delivery: DeliveryService,
    private readonly reservations: ReservationsService,
    private readonly events: EventsService,
    private readonly growth: GrowthService,
    private readonly contracts: ContractsService,
    private readonly settlement: SettlementService,
    private readonly integrations: IntegrationsService,
    private readonly payments: PaymentsService,
    private readonly groupOrders: GroupOrdersService,
    private readonly programs: ProgramsService,
    private readonly approvals: ApprovalsService,
    private readonly alerts: AlertsService,
    private readonly locationsAdmin: LocationsAdminService,
    private readonly merchantsAdmin: MerchantsAdminService,
    private readonly brandsAdmin: BrandsAdminService,
    private readonly menuAdmin: MenuAdminService,
    private readonly customers: CustomersService,
    private readonly support: SupportService,
  ) {}

  private async locked(name: string, ttlMs: number, fn: () => Promise<unknown>) {
    const release = await this.redis.lock(`job:${name}`, ttlMs);
    if (!release) return;
    try {
      const r = await fn();
      if (r && typeof r === 'object' ? Object.values(r as object).some((v) => v) : r) this.log.debug(`${name}: ${JSON.stringify(r)}`);
    } catch (e) {
      this.log.error(`${name} failed: ${(e as Error).message}`);
    } finally {
      await release();
    }
  }

  @Interval(3000) outbox() { return this.locked('outbox', 30_000, () => this.notifications.relayOutbox()); }
  @Interval(4000) deliverNotifications() { return this.locked('notify', 30_000, () => this.notifications.deliverQueued()); }
  @Interval(30_000) orderEscalation() { return this.locked('order-escalation', 60_000, () => this.orders.escalateUnacknowledged()); }
  @Interval(60_000) alertDetectors() { return this.locked('alert-detect', 120_000, () => this.alerts.detect()); }
  @Interval(60_000) alertEscalation() { return this.locked('alert-escalate', 60_000, () => this.alerts.escalate()); }
  @Interval(300_000) restartRamps() { return this.locked('restart-ramps', 60_000, () => this.locationsAdmin.clearRamps()); }
  @Interval(3_600_000) documentExpiry() { return this.locked('doc-expiry', 600_000, () => this.merchantsAdmin.documentExpiry()); }
  @Interval(900_000) brandRights() { return this.locked('brand-rights', 300_000, () => this.brandsAdmin.expireRights()); }
  @Interval(60_000) priceChanges() { return this.locked('price-changes', 60_000, () => this.menuAdmin.applyDue()); }
  @Interval(60_000) supportSla() { return this.locked('support-sla', 60_000, () => this.support.slaSweep()); }
  @Interval(3_600_000) deliveryHousekeepingDaily() { return this.locked('delivery-docs-proofs', 600_000, async () => ({ docs: await this.delivery.expireCourierDocs(), proofs: await this.delivery.purgeProofs() })); }
  @Interval(60_000) kitchenLoad() { return this.locked('kitchen-load', 60_000, () => this.kitchen.loadSweep()); }
  @Interval(60_000) pickupNoShow() { return this.locked('pickup-no-show', 60_000, () => this.orders.noShowSweep()); }
  @Interval(3_600_000) privacySweep() { return this.locked('privacy', 600_000, () => this.customers.privacySweep()); }
  @Interval(300_000) approvalExpiry() { return this.locked('approval-expiry', 60_000, () => this.approvals.expireStale()); }
  @Interval(60_000) scheduledOrders() { return this.locked('scheduled-orders', 60_000, () => this.orders.releaseScheduled()); }
  @Interval(30_000) deliveryHousekeeping() {
    return this.locked('delivery', 60_000, async () => ({ expiredQuotes: await this.delivery.expireQuotes(), expiredOffers: await this.delivery.expireOffers(), late: await this.delivery.flagLate(), simulated: await this.delivery.simulateMock() }));
  }
  @Interval(30_000) reservationHousekeeping() {
    return this.locked('reservations', 60_000, async () => ({ holds: await this.reservations.expireHolds(), waitlist: await this.reservations.expireWaitlistOffers(), ticketHolds: await this.events.expireTicketHolds(), groupLocks: await this.groupOrders.lockPastCutoff() }));
  }
  @Interval(5 * 60_000) reminders() { return this.locked('reminders', 5 * 60_000, () => this.reservations.sendReminders()); }
  @Interval(10 * 60_000) noShows() { return this.locked('no-shows', 5 * 60_000, () => this.reservations.autoNoShow()); }
  @Interval(60_000) devices() { return this.locked('devices', 60_000, () => this.integrations.sweepOffline()); }
  @Interval(10 * 60_000) retryNotifications() { return this.locked('retry-notify', 60_000, () => this.notifications.retryFailed()); }

  @Cron(CronExpression.EVERY_DAY_AT_3AM) daily() {
    return this.locked('daily', 30 * 60_000, async () => ({
      quotes: await this.orders.expireQuotes(),
      proposals: await this.events.expireProposals(),
      credits: await this.payments.expireCredits(),
      points: await this.growth.expirePoints(),
      campaigns: await this.growth.stopExhaustedOrEnded(),
      subscriptions: (await this.contracts.billDueSubscriptions()).length,
      memberships: await this.growth.renewDue(),
      pastDue: await this.settlement.markPastDueInvoices(),
    }));
  }

  /** Weekly settlement: Monday 04:00 — statements for the previous week, then submit payouts. */
  @Cron('0 4 * * 1') weeklySettlement() {
    return this.locked('weekly-settlement', 60 * 60_000, async () => {
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      const start = addDays(end, -7);
      const merchants = await this.settlement.closePeriod(start, end);
      const drivers = await this.settlement.closeDriverPeriod(start, end);
      const submitted = await this.settlement.submitPayouts();
      return { merchants: merchants.length, drivers: drivers.length, submitted };
    });
  }

  /** Retry failed payouts hourly with backoff handled in submitPayouts. */
  @Cron(CronExpression.EVERY_HOUR) payoutRetry() { return this.locked('payout-retry', 10 * 60_000, () => this.settlement.submitPayouts()); }

  /** Monthly: cover invoices and creator royalties for the previous month. */
  @Cron('0 5 1 * *') monthly() {
    return this.locked('monthly', 60 * 60_000, async () => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { coverInvoices: (await this.reservations.invoiceCovers(start, end)).length, royalties: (await this.programs.accrueRoyalties(start, end)).length };
    });
  }
}
