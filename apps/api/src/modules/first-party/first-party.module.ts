import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { FirstPartyController } from './first-party.controller';
import { FirstPartyAdminService } from './first-party.service';

/** Gutad first-party selling: Gutad's own locations, the marketplace policy for them, preview, report, operators. */
@Module({ imports: [DiscoveryModule, MerchantsModule], controllers: [FirstPartyController], providers: [FirstPartyAdminService] })
export class FirstPartyModule {}
