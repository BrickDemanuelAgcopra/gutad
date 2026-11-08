import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../../config/config';
import { DELIVERY_PROVIDER } from './delivery.constants';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DoorDashDriveProvider } from './providers/doordash-drive.provider';
import { MockDeliveryProvider } from './providers/mock-delivery.provider';
import { UberDirectProvider } from './providers/uber-direct.provider';

@Global()
@Module({
  controllers: [DeliveryController],
  providers: [
    MockDeliveryProvider,
    DoorDashDriveProvider,
    UberDirectProvider,
    {
      provide: DELIVERY_PROVIDER,
      useFactory: (mock: MockDeliveryProvider, dd: DoorDashDriveProvider, uber: UberDirectProvider) => {
        const cfg = loadConfig();
        if (cfg.DELIVERY_PROVIDER === 'doordash' && cfg.DOORDASH_DEVELOPER_ID) return dd;
        if (cfg.DELIVERY_PROVIDER === 'uber' && cfg.UBER_CLIENT_ID) return uber;
        return mock;
      },
      inject: [MockDeliveryProvider, DoorDashDriveProvider, UberDirectProvider],
    },
    DeliveryService,
  ],
  exports: [DeliveryService],
})
export class DeliveryModule {}
