import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { IamController } from './iam.controller';
import { IamService } from './iam.service';
import { IamGovernanceService } from './iam-governance.service';

/** 2 — staff access, emergency & support access, organization structure, audit search, approval engine. */
@Global()
@Module({ controllers: [SecurityController, IamController], providers: [SecurityService, ApprovalsService, IamService, IamGovernanceService], exports: [SecurityService, ApprovalsService, IamService, IamGovernanceService] })
export class SecurityModule {}
