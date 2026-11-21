import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { RedisService } from '../core/redis.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { InventoryService } from '../modules/operations/inventory.service';
import { SafetyService } from '../modules/operations/safety.service';
import { WorkforceService } from '../modules/operations/workforce.service';
import { AccountingService } from '../modules/finance/accounting.service';
import { KitchenService } from '../modules/kitchen/kitchen.service';
import { OrdersService } from '../modules/orders/orders.service';
import { DeliveryService } from '../modules/delivery/delivery.service';
import { CourierService } from '../modules/delivery/courier.service';
import { CourierForecastService } from '../modules/delivery/courier-forecast.service';
import { CourierIncentivesService } from '../modules/delivery/courier-incentives.service';
import { CourierFraudService } from '../modules/delivery/courier-fraud.service';
import { CourierSpecialService } from '../modules/delivery/courier-special.service';
import { CourierPayoutsService } from '../modules/delivery/courier-payouts.service';
import { ReservationsService } from '../modules/reservations/reservations.service';
import { EventsService } from '../modules/events/events.service';
import { GrowthService } from '../modules/growth/growth.service';
import { RewardsService } from '../modules/growth/rewards.service';
import { ContractsService } from '../modules/contracts/contracts.service';
import { SettlementService } from '../modules/settlement/settlement.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { GroupOrdersService } from '../modules/programs/group-orders.service';
import { ProgramsService } from '../modules/programs/programs.service';
import { addDays } from '../common/utils';
import { ApprovalsService } from '../modules/security/approvals.service';
import { IamGovernanceService } from '../modules/security/iam-governance.service';
import { AlertsService } from '../modules/ops/alerts.service';
import { LocationsAdminService } from '../modules/merchant-admin/locations-admin.service';
import { MerchantsAdminService } from '../modules/merchant-admin/merchants-admin.service';
import { BrandsAdminService } from '../modules/merchant-admin/brands-admin.service';
import { MenuAdminService } from '../modules/catalog/menu-admin.service';
import { CustomersService } from '../modules/customers/customers.service';
import { SupportService } from '../modules/support/support.service';
import { SensorsService } from '../modules/operations/sensors.service';
import { EquipmentVendorService } from '../modules/operations/equipment-vendor.service';
import { GlPushService } from '../modules/finance/gl-push.service';
import { ChefCalendarService } from '../modules/chefs/chef-calendar.service';
import { ChefRequestsService } from '../modules/chefs/chef-requests.service';
import { ChefOpsService } from '../modules/chefs/chef-ops.service';

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
    private readonly accounting: AccountingService,
    private readonly inventory: InventoryService,
    private readonly safety: SafetyService,
    private readonly workforce: WorkforceService,
    private readonly delivery: DeliveryService,
    private readonly courier: CourierService,
    private readonly courierForecast: CourierForecastService,
    private readonly courierIncentives: CourierIncentivesService,
    private readonly courierFraud: CourierFraudService,
    private readonly courierSpecial: CourierSpecialService,
    private readonly courierPayouts: CourierPayoutsService,
    private readonly reservations: ReservationsService,
    private readonly events: EventsService,
    private readonly growth: GrowthService,
    private readonly rewards: RewardsService,
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
    private readonly sensors: SensorsService,
    private readonly equipmentVendors: EquipmentVendorService,
    private readonly glPush: GlPushService,
    private readonly iam: IamGovernanceService,
    private readonly chefCalendar: ChefCalendarService,
    private readonly chefRequests: ChefRequestsService,
    private readonly chefOps: ChefOpsService,
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
  // Courier R3: campaign windows and settlement, hourly fraud patterns, forecast (nightly when stale) + partner fee postings
  @Interval(900_000) courierCampaigns() { return this.locked('courier-campaigns', 600_000, () => this.courierIncentives.sweep()); }
  // Courier R4: certification expiry and refused orders the kitchen hasn't received
  @Interval(3_600_000) courierSpecialSweep() { return this.locked('courier-special', 600_000, () => this.courierSpecial.sweep()); }
  @Interval(3_600_000) courierFraudPatterns() { return this.locked('courier-fraud', 600_000, () => this.courierFraud.patternSweep()); }
  @Interval(3_600_000) courierForecastAndRecon() { return this.locked('courier-forecast-recon', 900_000, async () => ({ forecast: await this.courierForecast.rebuildIfStale(), recon: await this.courierPayouts.runRecon() })); }
  @Interval(3_600_000) deliveryHousekeepingDaily() { return this.locked('delivery-docs-proofs', 600_000, async () => ({ docs: await this.delivery.expireCourierDocs(), checks: await this.courier.expireChecks(), proofs: await this.delivery.purgeProofs() })); }
  @Interval(3_600_000) inventoryExpiry() { return this.locked('lot-expiry', 600_000, () => this.inventory.expireLots()); }
  @Interval(900_000) foodSafetyClusters() { return this.locked('fs-clusters', 300_000, () => this.safety.clusterSweep()); }
  @Interval(300_000) deviceHealth() { return this.locked('device-health', 120_000, () => this.workforce.deviceSweep()); }
  @Interval(86_400_000) equipmentService() { return this.locked('equipment-service', 600_000, () => this.workforce.maintenanceSweep()); }
  @Interval(60_000) kitchenLoad() { return this.locked('kitchen-load', 60_000, () => this.kitchen.loadSweep()); }
  @Interval(60_000) pickupNoShow() { return this.locked('pickup-no-show', 60_000, () => this.orders.noShowSweep()); }
  @Interval(3_600_000) privacySweep() { return this.locked('privacy', 600_000, () => this.customers.privacySweep()); }
  @Interval(60_000) iamSweep() { return this.locked('iam-sweep', 60_000, () => this.iam.sweep()); }
  @Interval(3_600_000) iamHourly() { return this.locked('iam-hourly', 600_000, () => this.iam.hourly()); }
  @Interval(300_000) approvalExpiry() { return this.locked('approval-expiry', 60_000, () => this.approvals.expireStale()); }
  @Interval(300_000) chefCapacityHolds() { return this.locked('chef-capacity-holds', 60_000, () => this.chefCalendar.releaseExpired()); }
  @Interval(3_600_000) chefDocuments() { return this.locked('chef-documents', 600_000, () => this.chefOps.documentSweep()); }
  @Interval(300_000) chefQuality() { return this.locked('chef-quality', 240_000, () => this.chefOps.qualitySweep()); }
  @Interval(300_000) chefRequestDeadlines() { return this.locked('chef-request-deadlines', 120_000, () => this.chefRequests.expireDue()); }
  @Interval(60_000) chefOrderDeadlines() { return this.locked('chef-order-deadlines', 60_000, async () => ({ ...(await this.orders.expireUnacceptedChefOrders()), ...(await this.orders.recognizeCompletedChefOrders()) })); }
  @Interval(60_000) scheduledOrders() { return this.locked('scheduled-orders', 60_000, () => this.orders.releaseScheduled()); }
  @Interval(30_000) deliveryHousekeeping() {
    return this.locked('delivery', 60_000, async () => ({ expiredQuotes: await this.delivery.expireQuotes(), expiredOffers: await this.delivery.expireOffers(), released: await this.delivery.releaseHeld(), late: await this.delivery.flagLate(), simulated: await this.delivery.simulateMock(), noShows: await this.courier.markNoShows() }));
  }
  @Interval(30_000) reservationHousekeeping() {
    return this.locked('reservations', 60_000, async () => ({ holds: await this.reservations.expireHolds(), waitlist: await this.reservations.expireWaitlistOffers(), ticketHolds: await this.events.expireTicketHolds(), groupLocks: await this.groupOrders.lockPastCutoff() }));
  }
  @Interval(5 * 60_000) reminders() { return this.locked('reminders', 5 * 60_000, () => this.reservations.sendReminders()); }
  @Interval(10 * 60_000) noShows() { return this.locked('no-shows', 5 * 60_000, () => this.reservations.autoNoShow()); }
  @Interval(60_000) devices() { return this.locked('devices', 60_000, () => this.integrations.sweepOffline()); }
  @Interval(120_000) sensorOffline() { return this.locked('sensor-offline', 120_000, () => this.sensors.offlineSweep()); }
  @Interval(60_000) equipmentVendorPoll() { return this.locked('equipment-vendor-poll', 300_000, () => this.equipmentVendors.pollSweep()); }
  @Interval(300_000) glPushRetry() { return this.locked('gl-push-retry', 300_000, () => this.glPush.retryDue()); }
  @Interval(10 * 60_000) retryNotifications() { return this.locked('retry-notify', 60_000, () => this.notifications.retryFailed()); }

  @Cron(CronExpression.EVERY_DAY_AT_3AM) daily() {
    return this.locked('daily', 30 * 60_000, async () => ({
      quotes: await this.orders.expireQuotes(),
      proposals: await this.events.expireProposals(),
      credits: await this.accounting.postBreakage(),
      points: await this.growth.expirePoints(),
      campaigns: await this.growth.stopExhaustedOrEnded(),
      subscriptions: (await this.contracts.billDueSubscriptions()).length,
      memberships: await this.growth.renewDue(),
      challengeWindows: await this.rewards.expireWindows(),
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
      // 19.4 the weekly run batches eligible payouts; over the release limit the batch waits for approval
      const submitted = await this.settlement.createBatch(null, { note: 'Weekly settlement' });
      return { merchants: merchants.length, drivers: drivers.length, submitted };
    });
  }

  /** Retry failed payouts hourly with backoff handled in submitPayouts. */
  @Cron(CronExpression.EVERY_HOUR) payoutRetry() { return this.locked('payout-retry', 10 * 60_000, async () => ({ holds: await this.settlement.releaseExpiredHolds(), ...(await this.settlement.submitPayouts()) })); }

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
