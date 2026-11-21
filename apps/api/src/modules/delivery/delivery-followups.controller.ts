import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { LiveDeliveryEvent } from '@gutad/shared';
import { assertCan, assertOrgAccess, can, CurrentUser, isPlatformStaff, JwtPayload, Public, staffCovers } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DB, Db } from '../../db/db.module';
import { locations } from '../../db/schema';
import { RedisService } from '../../core/redis.service';
import { CourierFilesService, MAX_COURIER_FILE_BYTES, type IncomingFile } from './courier-files.service';
import { DeliveryService } from './delivery.service';
import { LiveService } from './live.service';
import { DeliveryProviderRegistry } from './providers/provider-registry';
import { RoutingService } from './routing.service';
import { CourierService } from './courier.service';

const Pt = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** Phase G follow-ups: live push (17.1-R), courier document files (16.2-U), routing (15.3-R), partner providers (17.9-M). */
@ApiTags('12/13 Delivery & drivers')
@Controller()
export class DeliveryFollowupsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly live: LiveService,
    private readonly files: CourierFilesService,
    private readonly routing: RoutingService,
    private readonly registry: DeliveryProviderRegistry,
    private readonly delivery: DeliveryService,
    private readonly courier: CourierService,
  ) {}

  /**
   * 17.1-R server-sent events: courier positions and delivery status changes. EventSource cannot send headers, so the
   * access token may come as `?token=`. With `locationId` the merchant sees its own location; without it delivery staff see all.
   */
  @Public() @Get('live/delivery') async stream(@Req() req: Request, @Res() res: Response, @Query('token') token?: string, @Query('locationId') locationId?: string) {
    const header = req.headers.authorization;
    const raw = token || (header?.startsWith('Bearer ') ? header.slice(7) : '');
    let user: JwtPayload | null = null;
    try { user = raw ? await this.jwt.verifyAsync<JwtPayload>(raw) : null; } catch { user = null; }
    if (user?.sid && (await this.redis.client.exists(`sess:revoked:${user.sid}`).catch(() => 0))) user = null;
    if (!user) return res.status(401).json({ statusCode: 401, message: 'Sign in required' });
    const u = user;
    let match: (ev: LiveDeliveryEvent) => boolean;
    if (locationId) {
      const [loc] = /^[0-9a-f-]{36}$/i.test(locationId) ? await this.db.select({ id: locations.id, org: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).limit(1) : [];
      if (!loc) return res.status(404).json({ statusCode: 404, message: 'Location not found' });
      try { assertOrgAccess(u, loc.org, loc.id); } catch { return res.status(403).json({ statusCode: 403, message: 'No access to this location' }); }
      match = (ev) => (ev.type === 'job' ? ev.locationId === loc.id : ev.locationIds.includes(loc.id));
    } else {
      if (!(isPlatformStaff(u) && (can(u, 'delivery.read') || can(u, 'ops.read')))) return res.status(403).json({ statusCode: 403, message: 'Requires permission: delivery.read' });
      match = (ev) => ev.type !== 'job' || !ev.organizationId || staffCovers(u, ev.organizationId, ev.locationId);
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    let closed = false;
    let off: () => void = () => undefined;
    res.on('close', () => { closed = true; off(); });
    off = await this.live.subscribe((ev) => { if (!closed && match(ev)) send(ev.type, ev); });
    if (closed) return off();
    send('ready', { at: new Date().toISOString(), scope: locationId ? 'location' : 'platform' });
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20_000);
    // a token expires: end the stream then, so the client reconnects with a fresh one
    const exp = (u as JwtPayload & { exp?: number }).exp;
    const ttl = exp ? Math.max(1000, exp * 1000 - Date.now()) : 3600_000;
    const end = setTimeout(() => res.end(), Math.min(ttl, 3600_000));
    res.on('close', () => { clearInterval(ping); clearTimeout(end); });
  }

  @ApiBearerAuth() @Get('live/delivery/status') liveStatus(@CurrentUser() u: JwtPayload) { assertCan(u, 'delivery.read', 'ops.read'); return { transport: 'sse', path: '/live/delivery', clientsOnThisNode: this.live.connectedClients }; }

  // 16.2-U
  @ApiBearerAuth() @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_COURIER_FILE_BYTES, files: 1 } }))
  @Post('driver/documents/upload') async upload(@CurrentUser() u: JwtPayload, @UploadedFile() file: IncomingFile | undefined, @Body(zod(z.object({ kind: z.string(), expiresAt: z.string().datetime().optional().or(z.literal('').transform(() => undefined)) }))) b: { kind: string; expiresAt?: string }) {
    const doc = await this.files.upload(u, file, b);
    await this.courier.syncDocChecks(doc.driverId);
    return doc;
  }
  @ApiBearerAuth() @Get('files/:id/link') fileLink(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.files.link(u, id); }
  @Public() @Get('files/:id/signed') async signed(@Param('id') id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const f = await this.files.readSigned(id, exp, sig);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.content);
  }
  @ApiBearerAuth() @Get('files/:id') async file(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const f = await this.files.read(u, id);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.content);
  }

  // 15.3-R
  @ApiBearerAuth() @Get('admin/delivery/routing') routingStatus(@CurrentUser() u: JwtPayload) { assertCan(u, 'delivery.read'); return this.routing.status(); }
  @ApiBearerAuth() @Post('admin/delivery/routing/test') async routingTest(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ from: Pt, to: Pt, minutesPerKm: z.number().positive().max(30).optional() }))) b: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; minutesPerKm?: number }) {
    assertCan(u, 'delivery.read');
    const mpk = b.minutesPerKm ?? (await this.delivery.dispatchCfg()).travelMinutesPerKm;
    const r = await this.routing.travel(b.from, b.to, mpk);
    return { ...r, minutes: Math.round(r.minutes * 10) / 10, km: Math.round(r.km * 100) / 100, minutesPerKm: mpk, provider: this.routing.providerName };
  }

  // 17.9-M
  @ApiBearerAuth() @Get('admin/delivery/provider-names') providerNames(@CurrentUser() u: JwtPayload) { assertCan(u, 'delivery.read'); return { primary: this.registry.primary.name, available: ['PLATFORM', ...this.registry.names()] }; }
  @Public() @Post('webhooks/delivery/:provider') webhook(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.delivery.ingestWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body)), req.headers as Record<string, string | undefined>, provider);
  }
}
