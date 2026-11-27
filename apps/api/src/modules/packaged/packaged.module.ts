import { Module } from '@nestjs/common';
import { PackagedController } from './packaged.controller';
import { PackagedService } from './packaged.service';

/** Packaged goods: product records, dated stock, review, recalls and the policy (stock service itself is in core). */
@Module({ controllers: [PackagedController], providers: [PackagedService], exports: [PackagedService] })
export class PackagedModule {}
