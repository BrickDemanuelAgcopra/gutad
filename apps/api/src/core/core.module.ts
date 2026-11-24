import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { LedgerService } from './ledger.service';
import { NotifyService } from './notify.service';
import { OutboxService } from './outbox.service';
import { RedisService } from './redis.service';
import { SettingsService } from './settings.service';
import { AclService } from './acl.service';
import { SecurityEventsService } from './security-events.service';
import { FirstPartyService } from './first-party.service';

/** Cross-cutting services every capability module relies on. */
@Global()
@Module({
  providers: [AuditService, OutboxService, LedgerService, NotifyService, CryptoService, RedisService, SettingsService, AclService, SecurityEventsService, FirstPartyService],
  exports: [AuditService, OutboxService, LedgerService, NotifyService, CryptoService, RedisService, SettingsService, AclService, SecurityEventsService, FirstPartyService],
})
export class CoreModule {}
