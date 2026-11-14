import { Global, Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { OperationsController } from './operations.controller';
import { SafetyService } from './safety.service';
import { WorkforceService } from './workforce.service';

@Global()
@Module({ controllers: [OperationsController], providers: [InventoryService, SafetyService, WorkforceService], exports: [InventoryService, SafetyService, WorkforceService] })
export class OperationsModule {}
