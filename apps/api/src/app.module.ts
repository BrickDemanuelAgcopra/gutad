import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module';
import { CoreModule } from './core/core.module';
import { JwtAuthGuard, RolesGuard } from './common/auth';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { GrowthModule } from './modules/growth/growth.module';
import { CrmModule } from './modules/crm/crm.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { EventsModule } from './modules/events/events.module';
import { ProgramsModule } from './modules/programs/programs.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { SupportModule } from './modules/support/support.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { JobsService } from './jobs/jobs.service';

/** Shared module graph for the API and the worker. */
export const DOMAIN_MODULES = [
  DbModule,
  CoreModule,
  AuthModule,
  MerchantsModule,
  DiscoveryModule,
  CatalogModule,
  ContractsModule,
  PaymentsModule,
  DeliveryModule,
  GrowthModule,
  CrmModule,
  KitchenModule,
  OrdersModule,
  ReservationsModule,
  EventsModule,
  ProgramsModule,
  SettlementModule,
  IntegrationsModule,
  SupportModule,
  ReportingModule,
  AdminModule,
  NotificationsModule,
];

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]), ...DOMAIN_MODULES],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}

/** Worker: same domain graph plus the scheduler; no HTTP controllers are listened on. */
@Module({
  imports: [ScheduleModule.forRoot(), ...DOMAIN_MODULES],
  providers: [JobsService],
})
export class WorkerModule {}
