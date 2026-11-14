import { Global, Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** 10 — customer accounts administration and self-service (cards, preferences, privacy, restrictions). */
@Global()
@Module({ imports: [SupportModule], controllers: [CustomersController], providers: [CustomersService], exports: [CustomersService] })
export class CustomersModule {}
