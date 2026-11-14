import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/** 9 — pricing, fees & tax administration and the checkout-price simulator. */
@Module({ imports: [AdminModule], controllers: [PricingController], providers: [PricingService], exports: [PricingService] })
export class PricingModule {}
