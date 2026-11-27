import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { LOT_ADJUST_KINDS, PACKAGED_CATEGORIES, PACKAGED_DATE_TYPES, PACKAGED_STORAGE, RECALL_SCOPES, SIZE_UOMS, type PackagedGoodsPolicy } from '@gutad/shared';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { PackagedService, type ProductInput } from './packaged.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Product = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).nullable().optional(),
  priceCents: z.number().int().min(0).max(1_000_000),
  imageUrl: z.string().max(500).nullable().optional(),
  allergens: z.array(z.string().max(40)).max(20).optional(),
  dietaryTags: z.array(z.string().max(40)).max(20).optional(),
  maxPerOrder: z.number().int().min(1).max(100).nullable().optional(),
  taxCategory: z.string().max(40).optional(),
  sku: z.string().max(64).nullable().optional(),
  gtin: z.string().max(20).nullable().optional(),
  brandName: z.string().max(80).nullable().optional(),
  size: z.number().positive().max(100000).nullable().optional(),
  sizeUom: z.enum(SIZE_UOMS).nullable().optional(),
  unitCount: z.number().int().min(1).max(500).optional(),
  category: z.enum(PACKAGED_CATEGORIES),
  storage: z.enum(PACKAGED_STORAGE),
  dateType: z.enum(PACKAGED_DATE_TYPES),
  minRemainingDays: z.number().int().min(0).max(730).nullable().optional(),
  ingredientsText: z.string().max(3000).nullable().optional(),
  countryOfOrigin: z.string().max(60).nullable().optional(),
  labelImageUrl: z.string().max(500).nullable().optional(),
  lowStockThreshold: z.number().int().min(0).max(10000).optional(),
});
const Receive = z.object({ locationId: z.string().uuid(), quantity: z.number().int().min(1).max(100000), lotCode: z.string().max(64).optional(), expiresOn: ymd.nullable().optional(), unitCostCents: z.number().int().min(0).max(10_000_000).optional(), supplierName: z.string().max(120).optional() });
const Adjust = z.object({ kind: z.enum(LOT_ADJUST_KINDS), quantity: z.number().int().min(-100000).max(100000), reason: z.string().min(3).max(300) });
const Recall = z.object({ scope: z.enum(RECALL_SCOPES), lotIds: z.array(z.string().uuid()).max(200).optional(), itemId: z.string().uuid().optional(), gtin: z.string().max(20).optional(), reason: z.string().min(5).max(1000), severity: z.enum(['LOW', 'HIGH', 'CRITICAL']).optional() });
const StaffRecall = Recall.extend({ organizationId: z.string().uuid().nullable().optional() });
const Review = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'SUSPEND']), note: z.string().min(3).max(1000) });
const Rule = z.object({ allowed: z.boolean(), review: z.boolean(), taxCategory: z.string().min(2).max(40) });
const Days = z.object({ AMBIENT: z.number().int().min(0).max(730), CHILLED: z.number().int().min(0).max(730), FROZEN: z.number().int().min(0).max(730) });
const Policy = z.object({
  enabled: z.boolean(), requireReview: z.boolean(), reviewFirstParty: z.boolean(),
  categories: z.record(z.enum(PACKAGED_CATEGORIES), Rule), minRemainingDays: Days, nearExpiryDays: Days,
  requireGtin: z.boolean(), requireLabelImage: z.boolean(), showStockBelow: z.number().int().min(0).max(1000), maxPerOrder: z.number().int().min(1).max(100),
  sellers: z.enum(['ALL', 'ALLOW_LIST']), allowOrgIds: z.array(z.string().uuid()).max(5000), blockedOrgIds: z.array(z.string().uuid()).max(5000),
}).partial();
const SavePolicy = z.object({ policy: Policy, reason: z.string().min(5).max(500) });

@ApiTags('Packaged goods')
@ApiBearerAuth()
@Controller()
export class PackagedController {
  constructor(private readonly svc: PackagedService) {}

  // merchant
  @Get('locations/:id/packaged') forLocation(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.forLocation(u, id); }
  @Post('categories/:id/packaged') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Product)) b: z.infer<typeof Product>) { return this.svc.createProduct(u, id, b as ProductInput); }
  @Get('packaged/:itemId') detail(@CurrentUser() u: JwtPayload, @Param('itemId') id: string) { return this.svc.productDetail(u, id); }
  @Patch('packaged/:itemId') update(@CurrentUser() u: JwtPayload, @Param('itemId') id: string, @Body(zod(Product.partial())) b: Partial<ProductInput>) { return this.svc.updateProduct(u, id, b); }
  @Post('packaged/:itemId/submit') submit(@CurrentUser() u: JwtPayload, @Param('itemId') id: string) { return this.svc.resubmit(u, id); }
  @Post('packaged/:itemId/lots') receive(@CurrentUser() u: JwtPayload, @Param('itemId') id: string, @Body(zod(Receive)) b: z.infer<typeof Receive>) { return this.svc.receive(u, id, b); }
  @Get('packaged/:itemId/movements') movements(@CurrentUser() u: JwtPayload, @Param('itemId') id: string, @Query('locationId') locationId: string) { return this.svc.movements(u, id, locationId); }
  @Post('packaged-lots/:lotId/adjust') adjust(@CurrentUser() u: JwtPayload, @Param('lotId') id: string, @Body(zod(Adjust)) b: z.infer<typeof Adjust>) { return this.svc.adjust(u, id, b); }
  @Post('locations/:id/packaged/recalls') recall(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Recall)) b: z.infer<typeof Recall>) { return this.svc.merchantRecall(u, id, b); }
  @Get('locations/:id/packaged/recalls') recalls(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.recalls(u, { locationId: id }); }
  @Post('packaged-recalls/:id/close') close(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3).max(500) }))) b: { note: string }) { return this.svc.closeRecall(u, id, b.note); }

  // Gutad staff
  @Get('admin/packaged') overview(@CurrentUser() u: JwtPayload) { return this.svc.overview(u); }
  @Get('admin/packaged/products') products(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('q') q?: string, @Query('orgId') orgId?: string) { return this.svc.adminProducts(u, { status, q, orgId }); }
  @Get('admin/packaged/products/:itemId') product(@CurrentUser() u: JwtPayload, @Param('itemId') id: string) { return this.svc.adminProduct(u, id); }
  @Post('admin/packaged/products/:itemId/review') review(@CurrentUser() u: JwtPayload, @Param('itemId') id: string, @Body(zod(Review)) b: z.infer<typeof Review>) { return this.svc.review(u, id, b.decision, b.note); }
  @Get('admin/packaged/policy') policy(@CurrentUser() u: JwtPayload) { return this.svc.getPolicy(u); }
  @Put('admin/packaged/policy') savePolicy(@CurrentUser() u: JwtPayload, @Body(zod(SavePolicy)) b: z.infer<typeof SavePolicy>) { return this.svc.savePolicy(u, b.policy as Partial<PackagedGoodsPolicy>, b.reason); }
  @Get('admin/packaged/recalls') adminRecalls(@CurrentUser() u: JwtPayload) { return this.svc.recalls(u, {}); }
  @Post('admin/packaged/recalls') staffRecall(@CurrentUser() u: JwtPayload, @Body(zod(StaffRecall)) b: z.infer<typeof StaffRecall>) { return this.svc.staffRecall(u, b); }
  @Post('admin/packaged/sweep') sweep(@CurrentUser() u: JwtPayload) { return this.svc.staffSweep(u); }
}
