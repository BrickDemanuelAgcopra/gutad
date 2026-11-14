import { BadRequestException, Body, Controller, Get, Global, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { loadConfig } from '../../config/config';
import { AuditService } from '../../core/audit.service';
import { NotificationsService } from './notifications.service';
import { Senders } from './senders';

const TestDto = z.object({ channel: z.enum(['EMAIL', 'SMS']), to: z.string().trim().min(3).max(200) });

@ApiTags('23 Notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}
  @Get() inbox(@CurrentUser() u: JwtPayload) { return this.svc.inbox(u); }
  @Get('unread') unread(@CurrentUser() u: JwtPayload) { return this.svc.unreadCount(u); }
  @Post(':id/read') read(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.markRead(u, id); }
}

/** Provider status and test sends for platform admins (Admin > Settings > Messaging). Never returns secrets. */
@ApiTags('23 Notifications')
@ApiBearerAuth()
@Controller('admin/messaging')
export class MessagingAdminController {
  constructor(private readonly senders: Senders, private readonly audit: AuditService) {}

  @Get() status(@CurrentUser() u: JwtPayload) {
    assertCan(u, 'settings.manage');
    const c = loadConfig();
    return {
      email: { provider: c.EMAIL_PROVIDER, from: c.EMAIL_FROM, fromName: c.EMAIL_FROM_NAME, replyTo: c.EMAIL_REPLY_TO || null, configured: c.EMAIL_PROVIDER === 'brevo' ? !!c.BREVO_API_KEY : c.EMAIL_PROVIDER === 'smtp' ? c.SMTP_URL.startsWith('http') : false },
      sms: { provider: c.SMS_PROVIDER, from: c.TWILIO_MESSAGING_SERVICE_SID ? `messaging service ${c.TWILIO_MESSAGING_SERVICE_SID.slice(0, 6)}…` : c.TWILIO_FROM || null, configured: c.SMS_PROVIDER === 'twilio' && !!c.TWILIO_ACCOUNT_SID && !!c.TWILIO_AUTH_TOKEN && !!(c.TWILIO_FROM || c.TWILIO_MESSAGING_SERVICE_SID) },
      push: { provider: 'expo', accessToken: !!c.EXPO_ACCESS_TOKEN },
    };
  }

  @Post('test') async test(@CurrentUser() u: JwtPayload, @Body(zod(TestDto)) b: z.infer<typeof TestDto>) {
    assertCan(u, 'settings.manage');
    if (b.channel === 'EMAIL' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.to)) throw new BadRequestException({ code: 'INVALID_EMAIL', message: 'Enter a valid email address' });
    if (b.channel === 'SMS' && !/^\+?[0-9 ()\-]{7,20}$/.test(b.to)) throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Enter a phone number in international format, e.g. +15551234567' });
    const r = { subject: 'Gutad test message', text: `This is a test message from Gutad, sent by ${u.email} at ${new Date().toISOString()}.

If you received it, ${b.channel === 'EMAIL' ? 'email' : 'SMS'} delivery is working.`, sms: 'Gutad test message: SMS delivery is working.' };
    let result: { provider: string; id?: string };
    try {
      result = b.channel === 'EMAIL' ? await this.senders.email(b.to, r) : await this.senders.sms(b.to, r);
    } catch (e) {
      await this.audit.log({ actorId: u.sub, action: 'messaging.test.failed', entityType: 'messaging', entityId: b.channel, after: { to: b.to, error: (e as Error).message.slice(0, 300) } });
      throw new BadRequestException({ code: 'SEND_FAILED', message: (e as Error).message });
    }
    await this.audit.log({ actorId: u.sub, action: 'messaging.test', entityType: 'messaging', entityId: b.channel, after: { to: b.to, ...result } });
    return { ok: true, ...result, note: result.provider === 'log' ? 'Provider is "log": the message was written to the API log, not delivered.' : undefined };
  }
}

@Global()
@Module({ controllers: [NotificationsController, MessagingAdminController], providers: [NotificationsService, Senders], exports: [NotificationsService] })
export class NotificationsModule {}
