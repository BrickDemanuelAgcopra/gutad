import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

@Module({ controllers: [ContractsController, PlansController], providers: [ContractsService, PlansService], exports: [ContractsService, PlansService] })
export class ContractsModule {}
