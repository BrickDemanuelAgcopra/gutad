import { Global, Module } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Global()
@Module({ controllers: [FinanceController], providers: [FinanceService, AccountingService], exports: [FinanceService, AccountingService] })
export class FinanceModule {}
