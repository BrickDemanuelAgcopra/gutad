import { Global, Module } from '@nestjs/common';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

@Global()
@Module({ controllers: [SettlementController], providers: [SettlementService], exports: [SettlementService] })
export class SettlementModule {}
