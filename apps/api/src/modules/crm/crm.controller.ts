import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CrmService } from './crm.service';

const GuestPatch = z.object({ notes: z.string().optional(), tags: z.array(z.string()).optional(), favorites: z.array(z.unknown()).optional(), contactPrefs: z.record(z.unknown()).optional() });
const SegmentDto = z.object({ name: z.string(), rules: z.object({ minVisits: z.number().int().optional(), minSpendCents: z.number().int().optional(), lastVisitWithinDays: z.number().int().optional(), tags: z.array(z.string()).optional() }) });
const ReviewDto = z.object({ locationId: z.string().uuid(), orderId: z.string().uuid().optional(), rating: z.number().int().min(1).max(5), body: z.string().max(2000).optional() });
const ModerateDto = z.object({ status: z.enum(['PUBLISHED', 'REJECTED']).optional(), merchantReply: z.string().optional() });

@ApiTags('21 Customer relationship management')
@Controller()
export class CrmController {
  constructor(private readonly svc: CrmService) {}

  @Public() @Get('public/locations/:id/reviews') reviews(@Param('id') id: string) { return this.svc.publicReviews(id); }
  @ApiBearerAuth() @Post('reviews') create(@CurrentUser() u: JwtPayload, @Body(zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { return this.svc.createReview(u, b); }
  @ApiBearerAuth() @Patch('reviews/:id') moderate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ModerateDto)) b: z.infer<typeof ModerateDto>) { return this.svc.moderate(u, id, b.status || 'PUBLISHED', b.merchantReply); }
  @ApiBearerAuth() @Get('organizations/:id/guests') search(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('q') q?: string) { return this.svc.search(u, id, q); }
  @ApiBearerAuth() @Get('guests/:id') get(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.get(u, id); }
  @ApiBearerAuth() @Patch('guests/:id') update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(GuestPatch)) b: z.infer<typeof GuestPatch>) { return this.svc.update(u, id, b); }
  @ApiBearerAuth() @Get('organizations/:id/segments') segments(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listSegments(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/segments') segment(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(SegmentDto)) b: z.infer<typeof SegmentDto>) { return this.svc.createSegment(u, id, b); }
}
