import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { LedgerService } from './ledger.service';
import { NotifyService } from './notify.service';
import { OutboxService } from './outbox.service';
import { RedisService } from './redis.service';
import { SettingsService } from './settings.service';

/** Cross-cutting services every capability module relies on. */
@Global()
@Module({
  providers: [AuditService, OutboxService, LedgerService, NotifyService, CryptoService, RedisService, SettingsService],
  exports: [AuditService, OutboxService, LedgerService, NotifyService, CryptoService, RedisService, SettingsService],
})
export class CoreModule {}
