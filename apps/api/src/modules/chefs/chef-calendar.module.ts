import { Global, Module } from '@nestjs/common';
import { ChefCalendarService } from './chef-calendar.service';

/** Chef cooking calendars and kitchen capacity: used by quotes, checkout, discovery and the chef portal. */
@Global()
@Module({ providers: [ChefCalendarService], exports: [ChefCalendarService] })
export class ChefCalendarModule {}
