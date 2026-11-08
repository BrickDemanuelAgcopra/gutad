import { Global, Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Global()
@Module({ imports: [ContractsModule], controllers: [EventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule {}
