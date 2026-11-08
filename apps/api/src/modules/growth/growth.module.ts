import { Global, Module } from '@nestjs/common';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';

@Global()
@Module({ controllers: [GrowthController], providers: [GrowthService], exports: [GrowthService] })
export class GrowthModule {}
