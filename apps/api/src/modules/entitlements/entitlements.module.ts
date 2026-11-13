import { Global, Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { FeatureGuard } from './requires-feature';

@Global()
@Module({ imports: [ContractsModule], controllers: [EntitlementsController], providers: [EntitlementsService, FeatureGuard], exports: [EntitlementsService, FeatureGuard] })
export class EntitlementsModule {}
