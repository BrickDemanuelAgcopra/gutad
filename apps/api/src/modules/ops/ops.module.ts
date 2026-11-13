import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { SupportModule } from '../support/support.module';
import { AlertsService } from './alerts.service';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

/** 1 & 12 — executive dashboard, live operations, alerts, central order management. */
@Module({ imports: [OrdersModule, SupportModule], controllers: [OpsController], providers: [OpsService, AlertsService], exports: [OpsService, AlertsService] })
export class OpsModule {}
