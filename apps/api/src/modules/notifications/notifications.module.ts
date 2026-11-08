import { Controller, Get, Global, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { NotificationsService } from './notifications.service';
import { Senders } from './senders';

@ApiTags('23 Notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}
  @Get() inbox(@CurrentUser() u: JwtPayload) { return this.svc.inbox(u); }
  @Get('unread') unread(@CurrentUser() u: JwtPayload) { return this.svc.unreadCount(u); }
  @Post(':id/read') read(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.markRead(u, id); }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService, Senders], exports: [NotificationsService] })
export class NotificationsModule {}
