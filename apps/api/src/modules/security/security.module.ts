import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

/** 2 — staff access, emergency & support access, organization structure, audit search, approval engine. */
@Global()
@Module({ controllers: [SecurityController], providers: [SecurityService, ApprovalsService], exports: [SecurityService, ApprovalsService] })
export class SecurityModule {}
