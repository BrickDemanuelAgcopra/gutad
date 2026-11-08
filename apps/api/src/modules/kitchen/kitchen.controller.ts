import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { KitchenService } from './kitchen.service';

const KitchenDto = z.object({ name: z.string(), addressLine1: z.string(), city: z.string(), region: z.string(), postalCode: z.string(), lat: z.number().optional(), lng: z.number().optional(), isShared: z.boolean().optional(), stations: z.array(z.object({ code: z.string(), name: z.string() })).optional() });
const IngredientDto = z.object({ id: z.string().uuid().optional(), name: z.string(), unit: z.string(), costCentsPerUnit: z.number().int().min(0).optional() });
const RecipeDto = z.object({ name: z.string(), yieldPortions: z.number().positive().optional(), laborMinutes: z.number().min(0).optional(), lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive() })), previousRecipeId: z.string().uuid().optional() });
const PoDto = z.object({ supplier: z.string(), lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive(), unitCostCents: z.number().int().min(0) })) });
const ReceiveDto = z.object({ received: z.array(z.object({ lineId: z.string().uuid(), receivedQty: z.number().min(0) })).default([]) });
const WasteDto = z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive(), reason: z.string().optional() });
const LaborDto = z.object({ userId: z.string().uuid().optional(), hours: z.number().positive(), rateCents: z.number().int().positive(), date: z.coerce.date() });

@ApiTags('09/10 Shared kitchen production, supply & costing')
@ApiBearerAuth()
@Controller()
export class KitchenController {
  constructor(private readonly svc: KitchenService) {}

  @Post('organizations/:id/kitchens') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(KitchenDto)) b: z.infer<typeof KitchenDto>) { return this.svc.createKitchen(u, id, b); }
  @Get('kitchens/:id') overview(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.overview(u, id); }
  @Post('kitchens/:id/brands') link(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ brandId: z.string().uuid(), isActive: z.boolean().optional() }))) b: { brandId: string; isActive?: boolean }) { return this.svc.linkBrand(u, id, b.brandId, b.isActive ?? true); }
  @Get('kitchens/:id/stations/queue') queue(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('station') station?: string) { return this.svc.stationQueue(u, id, station); }
  @Post('tickets/:id/transition') ticket(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ status: z.enum(['IN_PROGRESS', 'DONE', 'VOID']) }))) b: { status: 'IN_PROGRESS' | 'DONE' | 'VOID' }) { return this.svc.ticketTransition(u, id, b.status); }
  @Post('order-lines/:id/unavailable') unavailable(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.svc.lineUnavailable(u, id, b.note); }
  @Get('kitchens/:id/packing') packing(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.packingQueue(u, id); }
  @Post('packing/:id/verify') verify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ lineId: z.string().uuid() }))) b: { lineId: string }) { return this.svc.verifyLine(u, id, b.lineId); }
  @Post('packing/:id/release') release(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.releaseBag(u, id); }

  @Get('ingredients') ingredients() { return this.svc.listIngredients(); }
  @Roles('MERCHANT_OWNER', 'MERCHANT_MANAGER', 'KITCHEN', 'PLATFORM_ADMIN') @Post('ingredients') ingredient(@Body(zod(IngredientDto)) b: z.infer<typeof IngredientDto>) { return this.svc.upsertIngredient(b); }
  @Roles('MERCHANT_OWNER', 'MERCHANT_MANAGER', 'KITCHEN', 'PLATFORM_ADMIN') @Post('recipes') recipe(@Body(zod(RecipeDto)) b: z.infer<typeof RecipeDto>) { return this.svc.createRecipe(b); }
  @Get('recipes/:id/cost') cost(@Param('id') id: string) { return this.svc.recipeCost(id); }
  @Get('kitchens/:id/stock') stock(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.stock(u, id); }
  @Post('kitchens/:id/stock/par') par(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ ingredientId: z.string().uuid(), parLevel: z.number().min(0) }))) b: { ingredientId: string; parLevel: number }) { return this.svc.setPar(u, id, b.ingredientId, b.parLevel); }
  @Post('kitchens/:id/purchase-orders') po(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PoDto)) b: z.infer<typeof PoDto>) { return this.svc.createPurchaseOrder(u, id, b); }
  @Post('purchase-orders/:id/receive') receive(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReceiveDto)) b: z.infer<typeof ReceiveDto>) { return this.svc.receivePurchaseOrder(u, id, b.received); }
  @Post('kitchens/:id/waste') waste(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(WasteDto)) b: z.infer<typeof WasteDto>) { return this.svc.recordWaste(u, id, b); }
  @Post('kitchens/:id/labor') labor(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(LaborDto)) b: z.infer<typeof LaborDto>) { return this.svc.recordLabor(u, id, b); }
  @Get('kitchens/:id/contribution') contribution(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.contribution(u, id, from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000), to ? new Date(to) : new Date());
  }
}
