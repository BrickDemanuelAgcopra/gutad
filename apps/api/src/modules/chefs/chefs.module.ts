import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { StorageService } from '../../core/storage.service';
import { ChefApplicationsService } from './chef-applications.service';
import { ChefFilesService } from './chef-files.service';
import { ChefsController } from './chefs.controller';
import { ChefsService } from './chefs.service';
import { ChefDishesService } from './chef-dishes.service';

/** Gutad Chef Network: chef applications, profiles, files (later: dishes, availability, requests). */
@Module({ imports: [PaymentsModule], controllers: [ChefsController], providers: [ChefApplicationsService, ChefFilesService, ChefsService, ChefDishesService, StorageService], exports: [ChefApplicationsService, ChefFilesService, ChefsService, ChefDishesService] })
export class ChefsModule {}
