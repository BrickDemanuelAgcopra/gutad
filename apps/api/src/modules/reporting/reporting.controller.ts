import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequiresFeature } from '../entitlements/requires-feature';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ReportingService } from './reporting.service';

@ApiTags('29 Reporting & control')
@ApiBearerAuth()
@Controller()
export class ReportingController {
  constructor(private readonly svc: ReportingService) {}

  @Get('locations/:id/reports/dashboard') dashboard(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.locationDashboard(u, id, from, to); }
  @Get('locations/:id/reports/kitchen') kitchen(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.kitchenThroughput(u, id); }
  @RequiresFeature('advanced_analytics', 'param:id') @Get('locations/:id/reports/orders.csv') @Header('Content-Type', 'text/csv') csv(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.exportOrdersCsv(u, id, from, to); }
  @Get('locations/:id/shift/open') openShift(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.openShift(u, id); }
  @Post('locations/:id/shift/close') closeShift(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ cashCents: z.number().int().min(0).optional(), wasteNotes: z.string().optional(), carryForward: z.array(z.string()).optional() }))) b: { cashCents?: number; wasteNotes?: string; carryForward?: string[] }) { return this.svc.closeShift(u, id, b); }
  @Get('admin/reports/platform') platform(@CurrentUser() u: JwtPayload, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.platformDashboard(u, from, to); }
  @Get('admin/reports/retention') retention(@CurrentUser() u: JwtPayload) { return this.svc.merchantRetention(u); }
}
