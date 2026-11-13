import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { OnboardingModule } from '../onboarding/onboarding.module';

@Module({ imports: [OnboardingModule], controllers: [ContractsController, PlansController, BillingController], providers: [ContractsService, PlansService, BillingService], exports: [ContractsService, PlansService, BillingService] })
export class ContractsModule {}
