import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ContractsModule } from '../contracts/contracts.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { QuoteService } from './quote.service';

@Global()
@Module({
  imports: [CatalogModule, ContractsModule],
  controllers: [OrdersController],
  providers: [QuoteService, OrdersService],
  exports: [QuoteService, OrdersService],
})
export class OrdersModule {}
