import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CatalogService } from './catalog.service';
import { MenuAdminService, type MenuDoc } from './menu-admin.service';
import { Put, Res } from '@nestjs/common';
import type { Response } from 'express';

const ChannelEnum = z.enum(['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER', 'PHONE', 'WALK_IN', 'CAMPUS', 'CORPORATE', 'API']);
const MenuDto = z.object({ name: z.string().min(1), brandId: z.string().uuid().optional(), availableFrom: z.string().optional(), availableUntil: z.string().optional(), daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(), channels: z.array(ChannelEnum).optional() });
const MenuPatch = z.object({ name: z.string().optional(), isActive: z.boolean().optional(), availableFrom: z.string().nullable().optional(), availableUntil: z.string().nullable().optional(), daysOfWeek: z.array(z.number().int()).optional(), channels: z.array(ChannelEnum).optional() });
const CategoryDto = z.object({ name: z.string().min(1), sortOrder: z.number().int().optional() });
const ItemDto = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceCents: z.number().int().min(0),
  imageUrl: z.string().optional(),
  allergens: z.array(z.string()).optional(),
  dietaryTags: z.array(z.string()).optional(),
  channelPrices: z.record(z.number().int()).optional(),
  stationCode: z.string().optional(),
  recipeId: z.string().uuid().optional(),
  posExternalId: z.string().optional(),
  sortOrder: z.number().int().optional(),
  servingSize: z.string().nullable().optional(),
  photos: z.array(z.string()).optional(),
  nutrition: z.object({ calories: z.number().optional(), proteinG: z.number().optional(), carbsG: z.number().optional(), fatG: z.number().optional(), sodiumMg: z.number().optional(), sugarG: z.number().optional() }).optional(),
  kind: z.enum(['ITEM', 'BUNDLE', 'BEVERAGE', 'EXTRA', 'PACKAGING']).optional(),
  taxCategory: z.string().optional(),
  maxPerOrder: z.number().int().min(1).nullable().optional(),
  cookMinutes: z.number().int().min(0).max(240).nullable().optional(),
  handling: z.array(z.enum(['HOT', 'COLD', 'FRAGILE', 'ALLERGEN'])).optional(),
  isActive: z.boolean().optional(),
  allergenReviewNeeded: z.boolean().optional(),
  reason: z.string().optional(),
});
const DocItem = z.object({ id: z.string().uuid().optional(), name: z.string(), priceCents: z.number().int(), modifierGroupIds: z.array(z.string().uuid()).optional() }).passthrough();
const DocModifierGroup = z.object({ id: z.string().uuid().optional(), name: z.string(), minSelect: z.number().int().min(0), maxSelect: z.number().int().min(0), required: z.boolean(), options: z.array(z.object({ id: z.string().uuid().optional(), name: z.string(), priceCents: z.number().int(), soldOut: z.boolean().optional(), ingredientId: z.string().uuid().nullable().optional() })) });
const MenuDocDto = z.object({ name: z.string().optional(), brandId: z.string().uuid().optional(), categories: z.array(z.object({ id: z.string().uuid().optional(), name: z.string(), sortOrder: z.number().int().optional(), items: z.array(DocItem) })), modifierGroups: z.array(DocModifierGroup).optional() });
const SoldOutDto = z.object({ soldOut: z.boolean(), untilMinutes: z.number().int().positive().optional() });
const ModGroupDto = z.object({ name: z.string().min(1), minSelect: z.number().int().min(0).optional(), maxSelect: z.number().int().min(1).optional(), required: z.boolean().optional(), options: z.array(z.object({ name: z.string().min(1), priceCents: z.number().int().min(0).optional() })) });
const ImportDto = z.object({ name: z.string(), brandId: z.string().uuid().optional(), categories: z.array(z.object({ name: z.string(), items: z.array(z.object({ name: z.string(), priceCents: z.number().int(), description: z.string().optional(), allergens: z.array(z.string()).optional(), posExternalId: z.string().optional(), stationCode: z.string().optional() })) })) });

@ApiTags('05 Menu & offer catalog')
@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService, private readonly menus: MenuAdminService) {}

  // 7.7 versions
  @ApiBearerAuth() @Get('menus/:id/versions') versions(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.versions(u, id); }
  @ApiBearerAuth() @Post('menus/:id/drafts') draft(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.menus.createDraft(u, id, b.note); }
  @ApiBearerAuth() @Put('menu-versions/:id') saveDraft(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ document: MenuDocDto, note: z.string().optional() }))) b: { document: MenuDoc; note?: string }) { return this.menus.updateDraft(u, id, b.document, b.note); }
  @ApiBearerAuth() @Post('menu-versions/:id/submit') submit(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.submit(u, id); }
  @ApiBearerAuth() @Post('menu-versions/:id/publish') publish(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.menus.publish(u, id, b.note); }
  @ApiBearerAuth() @Post('menu-versions/:id/reject') rejectVersion(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.menus.reject(u, id, b.note); }
  @ApiBearerAuth() @Post('menu-versions/:id/rollback') rollback(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(3) }))) b: { reason: string }) { return this.menus.rollback(u, id, b.reason); }
  @ApiBearerAuth() @Get('menu-versions/:id/diff') diff(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.diff(u, id); }
  @ApiBearerAuth() @Get('admin/menu-reviews') reviewQueue(@CurrentUser() u: JwtPayload) { return this.menus.reviewQueue(u); }
  // 7.8 export & validation
  @ApiBearerAuth() @Get('menus/:id/export') async exportMenu(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('format') format: string, @Res() res: Response) {
    const f = format === 'csv' ? 'csv' : 'json';
    const body = await this.menus.exportMenu(u, id, f);
    res.setHeader('Content-Type', f === 'csv' ? 'text/csv' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="menu-${id.slice(0, 8)}.${f}"`);
    res.send(body);
  }
  @ApiBearerAuth() @Post('locations/:id/menus/validate-import') validate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MenuDocDto)) b: MenuDoc) { return this.menus.validateImport(u, id, b); }
  // 7.2 shared modifier groups, 7.3 allergens, 7.4 sharing & overrides
  @ApiBearerAuth() @Get('menus/:id/modifier-groups') groups(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.modifierGroupsForMenu(u, id); }
  @ApiBearerAuth() @Post('items/:id/modifier-groups/:groupId') attach(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('groupId') g: string) { return this.menus.attachGroup(u, id, g, true); }
  @ApiBearerAuth() @Delete('items/:id/modifier-groups/:groupId') detach(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('groupId') g: string) { return this.menus.attachGroup(u, id, g, false); }
  @ApiBearerAuth() @Get('items/:id/allergens') allergens(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.allergens(u, id); }
  @ApiBearerAuth() @Get('menus/:id/sharing') sharing(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.sharing(u, id); }
  @ApiBearerAuth() @Put('menus/:id/sharing') share(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ locationIds: z.array(z.string().uuid()) }))) b: { locationIds: string[] }) { return this.menus.shareMenu(u, id, b.locationIds); }
  @ApiBearerAuth() @Put('items/:id/locations/:locationId') override(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('locationId') loc: string, @Body(zod(z.object({ priceCents: z.number().int().min(0).nullable().optional(), hidden: z.boolean().optional(), soldOut: z.boolean().optional() }))) b: { priceCents?: number | null; hidden?: boolean; soldOut?: boolean }) { return this.menus.setOverride(u, id, loc, b); }
  // 9.7 price changes
  @ApiBearerAuth() @Post('items/:id/price-changes') schedule(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ newPriceCents: z.number().int().min(0), effectiveAt: z.string().datetime().optional(), locationId: z.string().uuid().nullable().optional(), channel: z.string().nullable().optional(), reason: z.string().optional() }))) b: { newPriceCents: number; effectiveAt?: string; locationId?: string | null; channel?: string | null; reason?: string }) { return this.menus.schedulePrice(u, id, b); }
  @ApiBearerAuth() @Delete('price-changes/:id') cancelPrice(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.cancelPriceChange(u, id); }
  @ApiBearerAuth() @Get('items/:id/price-history') priceHistory(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.menus.priceHistory(u, id); }

  @Public() @Get('public/locations/:id/menus') publicMenus(@Param('id') id: string, @Query('channel') channel?: string) {
    return this.svc.publicMenus(id, (ChannelEnum.safeParse(channel).success ? channel : 'MARKETPLACE') as never);
  }

  @ApiBearerAuth() @Get('locations/:id/menus') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listMenus(u, id); }
  @ApiBearerAuth() @Post('locations/:id/menus') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MenuDto)) b: z.infer<typeof MenuDto>) { return this.svc.createMenu(u, id, b); }
  @ApiBearerAuth() @Post('locations/:id/menus/import') importMenu(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ImportDto)) b: z.infer<typeof ImportDto>) { return this.svc.importMenu(u, id, b); }
  @ApiBearerAuth() @Patch('menus/:id') update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MenuPatch)) b: z.infer<typeof MenuPatch>) { return this.svc.updateMenu(u, id, b); }
  @ApiBearerAuth() @Post('menus/:id/categories') addCategory(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CategoryDto)) b: z.infer<typeof CategoryDto>) { return this.svc.addCategory(u, id, b); }
  @ApiBearerAuth() @Post('categories/:id/items') addItem(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ItemDto)) b: z.infer<typeof ItemDto>) { return this.svc.addItem(u, id, b); }
  @ApiBearerAuth() @Patch('items/:id') updateItem(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ItemDto.partial())) b: Partial<z.infer<typeof ItemDto>>) { return this.svc.updateItem(u, id, b); }
  @ApiBearerAuth() @Post('items/:id/sold-out') soldOut(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(SoldOutDto)) b: z.infer<typeof SoldOutDto>) { return this.svc.setSoldOut(u, id, b.soldOut, b.untilMinutes); }
  @ApiBearerAuth() @Delete('items/:id') deleteItem(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.deleteItem(u, id); }
  @ApiBearerAuth() @Post('items/:id/modifier-groups') modGroup(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ModGroupDto)) b: z.infer<typeof ModGroupDto>) { return this.svc.createModifierGroup(u, id, b); }
  @ApiBearerAuth() @Post('modifier-options/:id/sold-out') optSoldOut(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ soldOut: z.boolean() }))) b: { soldOut: boolean }) { return this.svc.setOptionSoldOut(u, id, b.soldOut); }
}
