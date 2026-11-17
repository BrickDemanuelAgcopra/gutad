import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { StorageService } from '../../core/storage.service';
import { ChefApplicationsService } from './chef-applications.service';
import { ChefFilesService } from './chef-files.service';
import { ChefsController } from './chefs.controller';
import { ChefsService } from './chefs.service';
import { ChefDishesService } from './chef-dishes.service';
import { ChefOptionsService } from './chef-options.service';
import { ChefRequestsController } from './chef-requests.controller';
import { ChefRequestsService } from './chef-requests.service';
import { ChefOpsController } from './chef-ops.controller';
import { ChefOpsService } from './chef-ops.service';

/** Gutad Chef Network: chef applications, profiles, files dishes, options and special requests. */
@Module({ imports: [PaymentsModule], controllers: [ChefsController, ChefRequestsController, ChefOpsController], providers: [ChefApplicationsService, ChefFilesService, ChefsService, ChefDishesService, ChefOptionsService, ChefRequestsService, ChefOpsService, StorageService], exports: [ChefApplicationsService, ChefFilesService, ChefsService, ChefDishesService, ChefOptionsService, ChefRequestsService, ChefOpsService] })
export class ChefsModule {}
