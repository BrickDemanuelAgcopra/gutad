import { Global, Module } from '@nestjs/common';
import { GiftCardsService } from './gift-cards.service';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';
import { RewardsService } from './rewards.service';

@Global()
@Module({ controllers: [GrowthController], providers: [GrowthService, RewardsService, GiftCardsService], exports: [GrowthService, RewardsService, GiftCardsService] })
export class GrowthModule {}
