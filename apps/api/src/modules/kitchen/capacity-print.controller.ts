import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { LocationLoadService } from './location-load.service';
import { PrintingService, type PrinterInput } from './printing.service';

const LoadDto = z.object({
  enabled: z.boolean().optional(),
  busyAtOpenOrders: z.number().int().min(1).max(500).optional(),
  overloadAtOpenOrders: z.number().int().min(2).max(1000).optional(),
  busyAtBacklogMinutes: z.number().int().min(1).max(600).nullable().optional(),
  overloadAtBacklogMinutes: z.number().int().min(1).max(900).nullable().optional(),
  parallelOrders: z.number().int().min(1).max(50).optional(),
  busyExtraMinutes: z.number().int().min(0).max(120).optional(),
});
const PrinterDto = z.object({
  name: z.string().min(1).max(60),
  stationCode: z.string().max(20).nullable().optional(),
  role: z.enum(['TICKETS', 'LABELS', 'BOTH']).optional(),
  protocol: z.enum(['LOG', 'RAW_TCP']).optional(),
  host: z.string().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  width: z.number().int().min(24).max(64).optional(),
  autoPrint: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const PrintDto = z.object({ printerId: z.string().uuid().optional() });

/** 13.7-L restaurant auto-throttle and 13.8-P network ticket printers. */
@ApiTags('08/09 Capacity & printers')
@ApiBearerAuth()
@Controller()
export class CapacityPrintController {
  constructor(private readonly load: LocationLoadService, private readonly print: PrintingService) {}

  // 13.7-L
  @Get('locations/:id/load') loadStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.load.status(u, id); }
  @Patch('locations/:id/load-settings') loadSettings(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(LoadDto)) b: z.infer<typeof LoadDto>) { return this.load.update(u, id, b); }
  @Post('admin/jobs/location-load') loadSweep(@CurrentUser() u: JwtPayload) { assertCan(u, 'kitchens.manage', 'ops.manage'); return this.load.sweep(); }

  // 13.8-P
  @Get('locations/:id/printers') printers(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.print.list(u, id); }
  @Post('locations/:id/printers') addPrinter(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PrinterDto)) b: z.infer<typeof PrinterDto>) { return this.print.create(u, id, b as PrinterInput); }
  @Patch('printers/:id') updPrinter(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PrinterDto.partial())) b: Partial<PrinterInput>) { return this.print.update(u, id, b); }
  @Delete('printers/:id') delPrinter(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.print.remove(u, id); }
  @Post('printers/:id/test') testPrint(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.print.test(u, id); }
  @Get('locations/:id/print-jobs') printJobs(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('status') status?: string) { return this.print.jobs(u, id, status); }
  @Post('print-jobs/:id/retry') retry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.print.retry(u, id); }
  @Post('tickets/:id/print') printTicket(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PrintDto)) b: z.infer<typeof PrintDto>) { return this.print.printTicket(u, id, b.printerId); }
  @Post('orders/:id/print-tickets') printOrder(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PrintDto)) b: z.infer<typeof PrintDto>) { return this.print.printOrder(u, id, b.printerId); }
  @Post('packing/:id/print-labels') printLabels(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PrintDto)) b: z.infer<typeof PrintDto>) { return this.print.printLabels(u, id, b.printerId); }
  @Post('admin/jobs/print-queue') queue(@CurrentUser() u: JwtPayload) { assertCan(u, 'kitchens.manage', 'ops.manage'); return this.print.processDue(); }
}
