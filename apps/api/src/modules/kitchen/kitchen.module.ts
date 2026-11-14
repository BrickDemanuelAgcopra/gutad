import { Global, Module } from '@nestjs/common';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
import { RecipesService } from './recipes.service';
import { CapacityPrintController } from './capacity-print.controller';
import { LocationLoadService } from './location-load.service';
import { PrintingService } from './printing.service';

@Global()
@Module({ controllers: [KitchenController, CapacityPrintController], providers: [KitchenService, RecipesService, LocationLoadService, PrintingService], exports: [KitchenService, RecipesService, LocationLoadService, PrintingService] })
export class KitchenModule {}
