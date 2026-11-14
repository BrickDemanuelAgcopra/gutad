import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CatalogModule } from '../catalog/catalog.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { OpsModule } from '../ops/ops.module';
import { BrandsAdminService } from './brands-admin.service';
import { LocationsAdminService } from './locations-admin.service';
import { MerchantAdminController } from './merchant-admin.controller';
import { MerchantsAdminService } from './merchants-admin.service';

/** 3–6 — locations, merchant onboarding & lifecycle, merchant portal administration, brand ownership. */
@Module({
  imports: [AdminModule, CatalogModule, MerchantsModule, OnboardingModule, OpsModule],
  controllers: [MerchantAdminController],
  providers: [LocationsAdminService, MerchantsAdminService, BrandsAdminService],
  exports: [LocationsAdminService, MerchantsAdminService, BrandsAdminService],
})
export class MerchantAdminModule {}
