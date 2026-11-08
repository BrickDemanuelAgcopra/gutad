import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { GroupOrdersService } from './group-orders.service';
import { MealKitsService } from './meal-kits.service';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';

@Global()
@Module({ imports: [CatalogModule], controllers: [ProgramsController], providers: [GroupOrdersService, MealKitsService, ProgramsService], exports: [GroupOrdersService, MealKitsService, ProgramsService] })
export class ProgramsModule {}
