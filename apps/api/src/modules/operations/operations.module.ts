import { Global, Module } from '@nestjs/common';
import { EquipmentVendorService } from './equipment-vendor.service';
import { InventoryService } from './inventory.service';
import { OperationsController } from './operations.controller';
import { OpsIntegrationsController } from './ops-integrations.controller';
import { PayrollService } from './payroll.service';
import { SafetyService } from './safety.service';
import { SensorsService } from './sensors.service';
import { SupplierPortalService } from './supplier-portal.service';
import { WorkforceService } from './workforce.service';

@Global()
@Module({
  controllers: [OperationsController, OpsIntegrationsController],
  providers: [InventoryService, SafetyService, WorkforceService, SupplierPortalService, SensorsService, PayrollService, EquipmentVendorService],
  exports: [InventoryService, SafetyService, WorkforceService, SupplierPortalService, SensorsService, PayrollService, EquipmentVendorService],
})
export class OperationsModule {}
