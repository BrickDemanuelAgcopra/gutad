import { Global, Module } from '@nestjs/common';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';

@Global()
@Module({ controllers: [CrmController], providers: [CrmService], exports: [CrmService] })
export class CrmModule {}
