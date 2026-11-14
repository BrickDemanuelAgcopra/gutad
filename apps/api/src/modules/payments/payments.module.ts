import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../../config/config';
import { PAYMENT_PROVIDER } from './payments.constants';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { CardSetupController } from './card-setup.controller';
import { CardSetupService } from './card-setup.service';
import { MockPaymentProvider } from './providers/mock-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';

@Global()
@Module({
  controllers: [PaymentsController, CardSetupController],
  providers: [
    MockPaymentProvider,
    StripePaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (mock: MockPaymentProvider, stripe: StripePaymentProvider) => (loadConfig().PAYMENT_PROVIDER === 'stripe' && loadConfig().STRIPE_SECRET_KEY ? stripe : mock),
      inject: [MockPaymentProvider, StripePaymentProvider],
    },
    PaymentsService,
    CardSetupService,
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER, CardSetupService],
})
export class PaymentsModule {}
