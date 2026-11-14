import { Global, Module } from '@nestjs/common';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
import { RecipesService } from './recipes.service';

@Global()
@Module({ controllers: [KitchenController], providers: [KitchenService, RecipesService], exports: [KitchenService, RecipesService] })
export class KitchenModule {}
