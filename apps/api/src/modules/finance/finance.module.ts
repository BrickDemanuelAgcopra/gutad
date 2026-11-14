import { Global, Module } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { GlController } from './gl.controller';
import { GlPushService } from './gl-push.service';

@Global()
@Module({ controllers: [FinanceController, GlController], providers: [FinanceService, AccountingService, GlPushService], exports: [FinanceService, AccountingService, GlPushService] })
export class FinanceModule {}
