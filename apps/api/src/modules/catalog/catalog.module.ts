import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { MenuAdminService } from './menu-admin.service';

@Module({ controllers: [CatalogController], providers: [CatalogService, MenuAdminService], exports: [CatalogService, MenuAdminService] })
export class CatalogModule {}
