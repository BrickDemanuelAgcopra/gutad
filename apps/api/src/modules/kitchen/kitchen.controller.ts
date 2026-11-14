import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload, RequiresPermission, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { KitchenService } from './kitchen.service';
import { RecipesService } from './recipes.service';

const KitchenDto = z.object({ name: z.string(), addressLine1: z.string(), city: z.string(), region: z.string(), postalCode: z.string(), lat: z.number().optional(), lng: z.number().optional(), isShared: z.boolean().optional(), stations: z.array(z.object({ code: z.string(), name: z.string() })).optional() });
const IngredientDto = z.object({ id: z.string().uuid().optional(), organizationId: z.string().uuid().nullable().optional(), name: z.string(), unit: z.string(), costCentsPerUnit: z.number().int().min(0).optional(), allergens: z.array(z.string()).optional() });
const RecipeFullDto = z.object({
  name: z.string().min(1),
  yieldPortions: z.number().positive().optional(),
  laborMinutes: z.number().min(0).optional(),
  portionSize: z.string().nullable().optional(),
  steps: z.array(z.object({ n: z.number().int(), text: z.string(), stationCode: z.string().optional(), minutes: z.number().optional() })).optional(),
  substitutions: z.array(z.object({ ingredientId: z.string().uuid(), substituteId: z.string().uuid(), ratio: z.number().positive().optional(), approved: z.boolean().optional() })).optional(),
  equipment: z.array(z.string()).optional(),
  prepMinutes: z.number().min(0).optional(),
  batchMaxPortions: z.number().int().positive().nullable().optional(),
  trainingUrl: z.string().nullable().optional(),
  trainingNotes: z.string().nullable().optional(),
  changeSummary: z.string().nullable().optional(),
  lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive() })).optional(),
});
const RecipeDto = z.object({ name: z.string(), yieldPortions: z.number().positive().optional(), laborMinutes: z.number().min(0).optional(), lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive() })), previousRecipeId: z.string().uuid().optional() });
const PoDto = z.object({ supplier: z.string(), lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive(), unitCostCents: z.number().int().min(0) })) });
const ReceiveDto = z.object({ received: z.array(z.object({ lineId: z.string().uuid(), receivedQty: z.number().min(0) })).default([]) });
const WasteDto = z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive(), reason: z.string().optional() });
const KitchenEventDto = z.object({ orderId: z.string().uuid(), orderLineId: z.string().uuid().optional(), kind: z.enum(['REMAKE', 'MISSING', 'QUALITY_FAIL']), reasonCode: z.string(), note: z.string().max(500).optional(), refire: z.boolean().optional() });
const LaborDto = z.object({ userId: z.string().uuid().optional(), hours: z.number().positive(), rateCents: z.number().int().positive(), date: z.coerce.date() });

@ApiTags('09/10 Shared kitchen production, supply & costing')
@ApiBearerAuth()
@Controller()
export class KitchenController {
  constructor(private readonly svc: KitchenService, private readonly recipes: RecipesService) {}

  @Post('organizations/:id/kitchens') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(KitchenDto)) b: z.infer<typeof KitchenDto>) { return this.svc.createKitchen(u, id, b); }
  @Get('kitchens/:id') overview(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.overview(u, id); }
  @Post('kitchens/:id/brands') link(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ brandId: z.string().uuid(), isActive: z.boolean().optional() }))) b: { brandId: string; isActive?: boolean }) { return this.svc.linkBrand(u, id, b.brandId, b.isActive ?? true); }
  @Get('kitchens/:id/stations/queue') queue(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('station') station?: string) { return this.svc.stationQueue(u, id, station); }
  @Post('tickets/:id/transition') ticket(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ status: z.enum(['IN_PROGRESS', 'DONE', 'VOID']) }))) b: { status: 'IN_PROGRESS' | 'DONE' | 'VOID' }) { return this.svc.ticketTransition(u, id, b.status); }
  @Post('order-lines/:id/unavailable') unavailable(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.svc.lineUnavailable(u, id, b.note); }
  @Get('kitchens/:id/packing') packing(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.packingQueue(u, id); }
  @Post('packing/:id/verify') verify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ lineId: z.string().uuid() }))) b: { lineId: string }) { return this.svc.verifyLine(u, id, b.lineId); }
  @Post('packing/:id/release') release(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.releaseBag(u, id); }

  // Phase F — KDS, routing, expo, remakes, performance, packing, pickup board, runner
  @Post('order-lines/:id/bump') bump(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ ready: z.boolean().default(true) }))) b: { ready: boolean }) { return this.svc.bumpLine(u, id, b.ready); }
  @Get('kitchens/:id/expo') expo(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.expo(u, id); }
  @Get('kitchens/:id/performance') perf(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('days') days?: string) { return this.svc.performance(u, id, Number(days) || 7); }
  @Get('kitchens/:id/events') kEvents(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('days') days?: string) { return this.svc.events(u, id, Number(days) || 7); }
  @Post('kitchen-events') kEvent(@CurrentUser() u: JwtPayload, @Body(zod(KitchenEventDto)) b: z.infer<typeof KitchenEventDto>) { return this.svc.recordEvent(u, b); }
  @Get('kitchens/:id/routes') routes(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.routes(u, id); }
  @Post('kitchens/:id/routes') addRoute(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ matchType: z.enum(['ITEM', 'CATEGORY', 'BRAND']), matchId: z.string().uuid(), stationCode: z.string().min(1) }))) b: { matchType: 'ITEM' | 'CATEGORY' | 'BRAND'; matchId: string; stationCode: string }) { return this.svc.addRoute(u, id, b); }
  @Delete('station-routes/:id') delRoute(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.removeRoute(u, id); }
  @Patch('kitchens/:id/settings') kSettings(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ defaultStationCode: z.string().nullable().optional(), autoThrottle: z.object({ enabled: z.boolean().optional(), busyAtActiveTickets: z.number().int().min(1).optional(), overloadAtActiveTickets: z.number().int().min(1).optional(), busyExtraMinutes: z.number().int().min(0).max(120).optional(), recoverRatio: z.number().min(0.1).max(1).optional() }).nullable().optional() }))) b: { defaultStationCode?: string | null; autoThrottle?: Record<string, unknown> | null }) { return this.svc.updateKitchen(u, id, b); }
  @Get('locations/:id/packing') locPacking(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.packingForLocation(u, id); }
  @Post('packing/:id/checklist') check(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ key: z.string(), done: z.boolean() }))) b: { key: string; done: boolean }) { return this.svc.checkItem(u, id, b.key, b.done); }
  @Post('packing/:id/bags') bags(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ count: z.number().int().min(1).max(12) }))) b: { count: number }) { return this.svc.setBags(u, id, b.count); }
  @Get('packing/:id/labels') labels(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.labels(u, id); }
  @Get('locations/:id/pickup-board') board(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.pickupBoard(u, id); }
  @Get('admin/kitchens') adminKitchens(@CurrentUser() u: JwtPayload) { return this.svc.adminKitchens(u); }
  /** Re-evaluate kitchen load now (normally every minute). */
  @Post('admin/jobs/kitchen-load') loadNow(@CurrentUser() u: JwtPayload) { assertCan(u, 'kitchens.manage'); return this.svc.loadSweep(); }
  @Get('locations/:id/packing-settings') packSettings(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.packingSettings(u, id); }
  @Get('locations/:id/runner') runner(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.runner(u, id); }

  @Get('ingredients') ingredients(@CurrentUser() u: JwtPayload, @Query('organizationId') orgId?: string) { return this.recipes.listIngredients(u, orgId); }
  @Post('ingredients') ingredient(@CurrentUser() u: JwtPayload, @Body(zod(IngredientDto)) b: z.infer<typeof IngredientDto>) { return this.recipes.upsertIngredient(u, b); }
  /** Shared catalog recipes (Gutad culinary only); merchants use /organizations/:id/recipes with release approval. */
  @RequiresPermission('culinary.manage') @Post('recipes') recipe(@Body(zod(RecipeDto)) b: z.infer<typeof RecipeDto>) { return this.svc.createRecipe(b); }
  @Get('organizations/:id/recipes') orgRecipes(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.recipes.list(u, id); }
  @Post('organizations/:id/recipes') createRecipe(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RecipeFullDto.extend({ previousRecipeId: z.string().uuid().optional() }))) b: z.infer<typeof RecipeFullDto> & { previousRecipeId?: string }) { return this.recipes.create(u, id, b); }
  @Get('organizations/:id/allergen-review') allergenReview(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.recipes.allergenReview(u, id); }
  @Get('admin/culinary-queue') culinary(@CurrentUser() u: JwtPayload) { return this.recipes.culinaryQueue(u); }
  @Get('recipes/:id') recipeDetail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.recipes.detail(u, id); }
  @Patch('recipes/:id') updateRecipe(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RecipeFullDto.partial())) b: Partial<z.infer<typeof RecipeFullDto>>) { return this.recipes.update(u, id, b); }
  @Post('recipes/:id/trials') trial(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ notes: z.string().min(3), score: z.number().int().min(1).max(5).optional(), location: z.string().optional() }))) b: { notes: string; score?: number; location?: string }) { return this.recipes.trial(u, id, b); }
  @Post('recipes/:id/approve') approveRecipe(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.recipes.approve(u, id, b.note); }
  @Post('recipes/:id/acknowledge') ack(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.recipes.acknowledge(u, id); }
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
