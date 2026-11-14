import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../../config/config';
import { DELIVERY_PROVIDER } from '../delivery.constants';
import type { DeliveryJobResult, DeliveryProvider, DeliveryQuote, DeliveryQuoteInput } from './delivery-provider';
import { DoorDashDriveProvider } from './doordash-drive.provider';
import { MockDeliveryProvider } from './mock-delivery.provider';
import { UberDirectProvider } from './uber-direct.provider';

/** A second mock partner (different price and ETA) so two third-party providers can be configured without credentials. */
export class MockPartnerB extends MockDeliveryProvider {
  override readonly name: string = 'mock-b';
  override async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const q = await super.quote(input);
    return { ...q, providerQuoteId: `mockb_dq_${randomUUID()}`, feeCents: q.feeCents + 75, etaMinutes: q.etaMinutes + 4 };
  }
}

/** Failover drill: quotes like the mock but every dispatch fails (a provider outage). */
export class MockPartnerDown extends MockDeliveryProvider {
  override readonly name: string = 'mock-down';
  override async createJob(): Promise<DeliveryJobResult> {
    throw new Error('mock-down: provider unavailable (failover drill)');
  }
  override async findByExternalId(): Promise<DeliveryJobResult | null> {
    return null;
  }
}

/**
 * 17.9-M every third-party delivery provider the platform can use, by name. Real providers are listed only when their
 * credentials are set; the mock partners (mock, mock-b, mock-down) are available outside production or when the
 * configured provider is the mock.
 */
@Injectable()
export class DeliveryProviderRegistry {
  private readonly byName = new Map<string, DeliveryProvider>();

  constructor(@Inject(DELIVERY_PROVIDER) readonly primary: DeliveryProvider, mock: MockDeliveryProvider, dd: DoorDashDriveProvider, uber: UberDirectProvider) {
    const cfg = loadConfig();
    this.byName.set(primary.name, primary);
    if (cfg.DOORDASH_DEVELOPER_ID) this.byName.set(dd.name, dd);
    if (cfg.UBER_CLIENT_ID) this.byName.set(uber.name, uber);
    if (cfg.NODE_ENV !== 'production' || cfg.DELIVERY_PROVIDER === 'mock') {
      this.byName.set(mock.name, mock);
      const b = new MockPartnerB();
      const down = new MockPartnerDown();
      this.byName.set(b.name, b);
      this.byName.set(down.name, down);
    }
  }

  names() { return Array.from(this.byName.keys()); }
  has(name: string) { return this.byName.has(name); }
  /** The provider a job was sent to; falls back to the configured provider for older jobs. */
  get(name: string | null | undefined): DeliveryProvider { return (name && this.byName.get(name)) || this.primary; }
  isMock(name: string) { return name === 'mock' || name === 'mock-b' || name === 'mock-down'; }
}
