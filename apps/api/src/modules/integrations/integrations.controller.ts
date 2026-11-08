import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { IntegrationsService } from './integrations.service';

const CreateDto = z.object({ locationId: z.string().uuid().optional(), type: z.enum(['POS', 'PAYMENT', 'DELIVERY', 'MESSAGING', 'MAPS', 'PRINTER', 'TABLET', 'KDS', 'PARTNER_API']), provider: z.string(), credentials: z.record(z.unknown()).optional(), externalIds: z.record(z.unknown()).optional() });
const MapDto = z.object({ mappings: z.array(z.object({ entityType: z.enum(['MENU_ITEM', 'TABLE', 'LOCATION', 'MODIFIER']), internalId: z.string(), externalId: z.string() })).min(1) });
const DeviceDto = z.object({ kind: z.enum(['TABLET', 'PRINTER', 'KDS', 'HOST_SCREEN', 'PACKING_SCREEN']), name: z.string(), fallbackOwner: z.string().optional(), config: z.record(z.unknown()).optional() });

@ApiTags('27 Integrations & devices')
@Controller()
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Public() @Post('webhooks/integrations/:id') ingest(@Param('id') id: string, @Req() req: Request & { rawBody?: Buffer }, @Headers('x-signature') sig?: string) { return this.svc.ingest(id, req.rawBody || Buffer.from(JSON.stringify(req.body)), sig); }
  @Public() @Post('devices/heartbeat') heartbeat(@Headers('x-device-token') tok: string, @Body() body: Record<string, unknown>) { return this.svc.heartbeat(tok || '', body); }

  @ApiBearerAuth() @Get('organizations/:id/integrations') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.list(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/integrations') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CreateDto)) b: z.infer<typeof CreateDto>) { return this.svc.create(u, id, b); }
  @ApiBearerAuth() @Post('integrations/:id/mappings') map(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MapDto)) b: z.infer<typeof MapDto>) { return this.svc.map(u, id, b.mappings); }
  @ApiBearerAuth() @Get('locations/:id/devices') devices(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.devicesFor(u, id); }
  @ApiBearerAuth() @Post('locations/:id/devices') register(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DeviceDto)) b: z.infer<typeof DeviceDto>) { return this.svc.registerDevice(u, id, b); }
  @ApiBearerAuth() @Get('admin/integrations/health') health(@CurrentUser() u: JwtPayload) { return this.svc.health(u); }
  @ApiBearerAuth() @Post('admin/inbox/:id/replay') replayIn(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.replayInbox(u, id); }
  @ApiBearerAuth() @Post('admin/outbox/:id/replay') replayOut(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.replayOutbox(u, id); }
}
