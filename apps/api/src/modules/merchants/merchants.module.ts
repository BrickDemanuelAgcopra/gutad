import { Module } from '@nestjs/common';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

@Module({ imports: [OnboardingModule], controllers: [MerchantsController], providers: [MerchantsService], exports: [MerchantsService] })
export class MerchantsModule {}
