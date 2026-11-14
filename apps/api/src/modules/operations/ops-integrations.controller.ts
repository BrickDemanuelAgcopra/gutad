import { Body, Controller, Delete, ForbiddenException, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, isPlatformStaff, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { GlPushService } from '../finance/gl-push.service';
import { EquipmentVendorService } from './equipment-vendor.service';
import type { VendorEvent } from './equipment-vendors';
import { InventoryService } from './inventory.service';
import { PayrollService } from './payroll.service';
import { SensorsService } from './sensors.service';
import { SupplierPortalService } from './supplier-portal.service';

const InvoiceLine = z.object({ ingredientId: z.string().uuid(), quantity: z.number().min(0), unitCostCents: z.number().int().min(0) });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const VendorEventDto = z.object({ id: z.string().max(200).optional(), kind: z.enum(['TELEMETRY', 'MAINTENANCE', 'FAULT', 'STATUS']), code: z.string().max(100).optional(), severity: z.enum(['INFO', 'LOW', 'HIGH', 'CRITICAL']).optional(), message: z.string().max(1000).optional(), metrics: z.record(z.number()).optional(), at: z.string().datetime().optional(), softwareVersion: z.string().max(100).optional(), status: z.enum(['OK', 'DEGRADED', 'DOWN', 'OFFLINE']).optional() });

/** Follow-ups C: forecast factors (21.6-S), supplier portal & EDI (21.8-P), temperature sensors (22.2-S), payroll providers (23.3-P), equipment vendor feeds (23.8-V). */
@ApiTags('21-23 Inventory, food safety, workforce')
@ApiBearerAuth()
@Controller()
export class OpsIntegrationsController {
  constructor(private readonly inv: InventoryService, private readonly portal: SupplierPortalService, private readonly sensors: SensorsService, private readonly payroll: PayrollService, private readonly vendors: EquipmentVendorService, private readonly gl: GlPushService) {}

  // 21.6-S
  @Get('kitchens/:id/forecast/factors') factors(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('days') d?: string) { return this.inv.forecastFactors(u, id, Number(d) || 7); }

  // 21.8-P staff side
  @Get('suppliers/:id/portal-access') portalAccess(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.portal.tokens(u, id); }
  @Post('suppliers/:id/portal-tokens') issue(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ label: z.string().max(100).optional(), expiresInDays: z.number().int().min(1).max(730).optional() }))) b: { label?: string; expiresInDays?: number }) { return this.portal.issue(u, id, b); }
  @Delete('supplier-portal-tokens/:id') revoke(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.portal.revoke(u, id); }
  // 21.8-P supplier side (per-supplier token, header x-supplier-token)
  @Public() @Get('supplier-portal') portalView(@Headers('x-supplier-token') t?: string) { return this.portal.portal(t); }
  @Public() @Post('supplier-portal/invoices') submit(@Headers('x-supplier-token') t: string | undefined, @Body(zod(z.object({ purchaseOrderId: z.string().uuid(), invoiceNumber: z.string().min(1).max(60), lines: z.array(InvoiceLine).min(1) }))) b: { purchaseOrderId: string; invoiceNumber: string; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }) { return this.portal.submit(t, b); }
  @Public() @Post('supplier-portal/edi') edi(@Headers('x-supplier-token') t: string | undefined, @Body(zod(z.object({ format: z.enum(['edi810', 'csv']), document: z.string().min(1) }))) b: { format: 'edi810' | 'csv'; document: string }) { return this.portal.upload(t, b.format, b.document); }

  // 22.2-S sensors
  @Get('safety/sensors') sensorOverview(@CurrentUser() u: JwtPayload) { return this.sensors.overview(u); }
  @Get('kitchens/:id/sensors') sensorList(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.sensors.list(u, id); }
  @Post('kitchens/:id/sensors') register(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ storageAreaId: z.string().uuid(), name: z.string().min(2).max(80), vendor: z.string().max(60).optional(), serial: z.string().max(80).optional(), offlineAfterMinutes: z.number().int().min(5).max(1440).nullable().optional() }))) b: Parameters<SensorsService['register']>[2]) { return this.sensors.register(u, id, b); }
  @Get('sensors/:id') sensor(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.sensors.recent(u, id); }
  @Post('sensors/:id/rotate-token') rotate(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.sensors.rotate(u, id); }
  @Delete('sensors/:id') retire(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.sensors.retire(u, id); }
  /** Sensor ingest (header x-sensor-token): one reading (`tempC`) or a batch (`readings`). */
  @Public() @Post('sensors/readings') ingest(@Headers('x-sensor-token') t: string | undefined, @Body(zod(z.object({ tempC: z.number().min(-60).max(150).optional(), at: z.string().datetime().optional(), readings: z.array(z.object({ tempC: z.number().min(-60).max(150), at: z.string().datetime().optional() })).max(500).optional(), batteryPct: z.number().int().min(0).max(100).optional() }))) b: { tempC?: number; at?: string; readings?: { tempC: number; at?: string }[]; batteryPct?: number }) { return this.sensors.ingest(t, { readings: [...(b.readings || []), ...(b.tempC !== undefined ? [{ tempC: b.tempC, at: b.at }] : [])], batteryPct: b.batteryPct }); }

  // 23.3-P payroll
  @Get('locations/:id/payroll/provider') payrollStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.payroll.status(u, id); }
  @Post('organizations/:id/payroll/connection') payrollConnect(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ provider: z.enum(['MOCK', 'GUSTO', 'ADP']), externalCompanyId: z.string().nullable().optional(), credentials: z.record(z.string()).optional(), employeeIds: z.record(z.string()).optional(), config: z.record(z.unknown()).optional() }))) b: Parameters<PayrollService['connect']>[2]) { return this.payroll.connect(u, id, b); }
  @Delete('organizations/:id/payroll/connection') payrollDisconnect(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.payroll.disconnect(u, id); }
  @Post('locations/:id/payroll/push') payrollPush(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ periodStart: Day, periodEnd: Day }))) b: { periodStart: string; periodEnd: string }) { return this.payroll.push(u, id, b); }
  @Post('payroll-batches/:id/retry') payrollRetry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.payroll.retry(u, id); }

  // 23.8-V equipment vendors (record & alert only; nothing is sent to machines)
  @Get('equipment/:id/vendor-link') vendorLink(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.vendors.get(u, id); }
  @Put('equipment/:id/vendor-link') vendorUpsert(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ vendor: z.enum(['MOCK', 'GENERIC', 'RATIONAL', 'WELBILT']), externalId: z.string().min(1).max(120), credentials: z.record(z.string()).optional(), config: z.record(z.unknown()).optional(), pollEnabled: z.boolean().optional(), rotateToken: z.boolean().optional() }))) b: Parameters<EquipmentVendorService['upsert']>[2]) { return this.vendors.upsert(u, id, b); }
  @Delete('equipment/:id/vendor-link') vendorUnlink(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.vendors.unlink(u, id); }
  @Post('equipment/:id/vendor-link/poll') vendorPoll(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.vendors.poll(u, id); }
  /** Vendor push feed (header x-vendor-token): telemetry, maintenance, faults, status. */
  @Public() @Post('equipment-vendor/events') vendorEvents(@Headers('x-vendor-token') t: string | undefined, @Body(zod(z.object({ events: z.array(VendorEventDto).min(1).max(200) }))) b: { events: VendorEvent[] }) { return this.vendors.ingest(t, b.events); }

  /** Run the follow-up sweeps now (sensor offline, vendor polls, GL push retries). */
  @Post('admin/jobs/integrations-sweep') sweep(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }).optional())) b?: { at?: string }) {
    if (!isPlatformStaff(u)) throw new ForbiddenException();
    // `at` evaluates sensor silence as of a later time (tests); it never moves data
    const at = b?.at ? new Date(b.at) : new Date();
    return Promise.all([this.sensors.offlineSweep(at), this.vendors.pollSweep(), this.gl.retryDue()]).then(([sensors, vendors, gl]) => ({ sensors, vendors, gl }));
  }
}
