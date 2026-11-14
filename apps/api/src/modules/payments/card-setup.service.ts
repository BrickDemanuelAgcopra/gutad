import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TEST_CARDS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { users } from '../../db/schema';
import { loadConfig } from '../../config/config';
import { RedisService } from '../../core/redis.service';
import type { JwtPayload } from '../../common/auth';
import { PAYMENT_PROVIDER } from './payments.constants';
import type { CardDetails, PaymentProvider } from './providers/payment-provider';

/** Deep links a hosted card setup may return to (the mobile app scheme; Expo dev links outside production). */
export function appReturnAllowed(to: string) {
  return /^gutad:\/\/[A-Za-z0-9/_-]*$/.test(to) || (loadConfig().NODE_ENV !== 'production' && /^exps?:\/\/[^\s?#]+$/.test(to));
}

/**
 * 10.3-P / 18.9-S card tokenization. With the live processor the card is collected by the processor's own field
 * (Stripe Elements + SetupIntent on web) or hosted setup page (mobile); Gutad receives only the token and reads the
 * masked details back from the processor. In test mode (mock processor) clients keep using the test-card picker.
 */
@Injectable()
export class CardSetupService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider, private readonly redis: RedisService) {}

  get live() {
    return this.provider.name !== 'mock';
  }

  /** Public client config: which processor, and the publishable key when Elements can be mounted. */
  clientConfig() {
    const key = loadConfig().STRIPE_PUBLISHABLE_KEY || null;
    return { provider: this.provider.name, publishableKey: this.provider.name === 'stripe' ? key : null, hostedSetup: !!this.provider.hostedSetup };
  }

  private async customer(userId: string) {
    const [u] = await this.db.select({ email: users.email, ref: users.paymentCustomerRef }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new NotFoundException();
    return u;
  }

  private async rememberCustomer(userId: string, ref: string | null, current: string | null) {
    if (ref && ref !== current) await this.db.update(users).set({ paymentCustomerRef: ref }).where(eq(users.id, userId));
  }

  /**
   * Start saving a card. Web (Elements): returns a SetupIntent client secret and the publishable key.
   * Mobile (`hosted`): returns the processor's hosted setup page; it comes back to `returnTo` (an app deep link).
   * Mock: returns the test cards to pick from.
   */
  async start(user: JwtPayload, input: { hosted?: boolean; returnTo?: string }) {
    const cfg = this.clientConfig();
    if (!this.live) return { ...cfg, mode: 'test' as const, testCards: TEST_CARDS.map((c) => ({ token: c.token, brand: c.brand, last4: c.last4, label: c.label })) };
    const u = await this.customer(user.sub);
    if (input.hosted || !cfg.publishableKey) {
      if (!this.provider.hostedSetup) throw new BadRequestException('This processor has no hosted card page');
      if (input.returnTo && !appReturnAllowed(input.returnTo)) throw new BadRequestException('Unsupported return link');
      const api = loadConfig().PUBLIC_API_URL.replace(/\/$/, '');
      const back = (status: string) => input.returnTo ? `${api}/public/payments/setup-return?to=${encodeURIComponent(input.returnTo)}&status=${status}&session_id={CHECKOUT_SESSION_ID}` : `${loadConfig().PUBLIC_WEB_URL.replace(/\/$/, '')}/account?tab=payments&card_setup=${status}&session_id={CHECKOUT_SESSION_ID}`;
      const s = await this.provider.hostedSetup({ email: u.email, customerRef: u.ref, successUrl: back('done'), cancelUrl: back('canceled') });
      await this.rememberCustomer(user.sub, s.customerRef, u.ref);
      await this.redis.setJson(`cardsetup:${s.sessionId}`, { userId: user.sub }, 3600);
      return { ...cfg, mode: 'hosted' as const, sessionId: s.sessionId, url: s.url };
    }
    if (!this.provider.setupForCustomer) throw new BadRequestException('This processor cannot save cards');
    const si = await this.provider.setupForCustomer({ email: u.email, customerRef: u.ref });
    await this.rememberCustomer(user.sub, si.customerRef, u.ref);
    return { ...cfg, mode: 'elements' as const, setupIntentId: si.providerSetupId, clientSecret: si.clientSecret };
  }

  /** Finish a hosted setup: the processor says which card was saved; Gutad gets the token and masked details. */
  async complete(user: JwtPayload, sessionId: string) {
    if (!this.live || !this.provider.completeHostedSetup) throw new BadRequestException('Nothing to complete in test mode');
    const owner = await this.redis.getJson<{ userId: string }>(`cardsetup:${sessionId}`);
    if (!owner || owner.userId !== user.sub) throw new NotFoundException('Card setup not found or expired');
    const done = await this.provider.completeHostedSetup(sessionId);
    if (!done) throw new BadRequestException({ message: 'The card was not saved yet', code: 'SETUP_INCOMPLETE' });
    const d = await this.describe(done.paymentMethodId);
    return { token: done.paymentMethodId, brand: d?.brand || 'card', last4: d?.last4 || '', expMonth: d?.expMonth ?? null, expYear: d?.expYear ?? null };
  }

  /** Masked card details from the processor (null in test mode or when the processor does not know the token). */
  async describe(paymentMethodId: string): Promise<CardDetails | null> {
    if (!this.live || !this.provider.describePaymentMethod || paymentMethodId.startsWith('mock_')) return null;
    return this.provider.describePaymentMethod(paymentMethodId);
  }
}
