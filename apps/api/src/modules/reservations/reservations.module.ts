import { Global, Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Global()
@Module({ imports: [ContractsModule], controllers: [ReservationsController], providers: [ReservationsService], exports: [ReservationsService] })
export class ReservationsModule {}
