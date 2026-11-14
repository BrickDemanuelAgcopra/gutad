import { Body, Controller, Get, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, MERCHANT_AGREEMENT_VERSION, OnboardingService, UploadedFile as UploadedDoc } from './onboarding.service';

const AcceptDto = z.object({ agreementVersion: z.string(), signatureName: z.string().min(2).max(120), signatureTitle: z.string().max(120).optional(), contractId: z.string().uuid().optional() });
const UploadDto = z.object({ docType: z.string(), locationId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)) });
const ReviewDto = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(1000).optional(), expiresAt: z.string().datetime().nullable().optional() });

@ApiTags('02 Merchant onboarding')
@ApiBearerAuth()
@Controller()
export class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  @Public() @Get('public/merchant-agreement') agreement() { return { version: MERCHANT_AGREEMENT_VERSION, documentTypes: DOCUMENT_TYPES, maxDocumentBytes: MAX_DOCUMENT_BYTES }; }

  @Get('organizations/:id/onboarding') status(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.status(u, id); }

  @Post('organizations/:id/onboarding/accept') accept(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(AcceptDto)) b: z.infer<typeof AcceptDto>, @Req() req: Request) {
    return this.svc.accept(u, id, b, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Get('organizations/:id/documents') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.list(u, id); }

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } }))
  @Post('organizations/:id/documents') upload(@CurrentUser() u: JwtPayload, @Param('id') id: string, @UploadedFile() file: UploadedDoc | undefined, @Body(zod(UploadDto)) b: z.infer<typeof UploadDto>) {
    return this.svc.upload(u, id, file, b.docType, b.locationId);
  }

  @Get('documents/:id/file') async file(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const d = await this.svc.file(u, id);
    res.setHeader('Content-Type', d.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${d.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(d.content);
  }

  @Post('documents/:id/review') review(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { return this.svc.review(u, id, b.status, b.note, b.expiresAt ? new Date(b.expiresAt) : null); }

  @Get('admin/onboarding/documents') queue(@CurrentUser() u: JwtPayload) { return this.svc.reviewQueue(u); }
}
