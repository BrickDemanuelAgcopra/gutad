import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CatalogService } from './catalog.service';

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
});
const SoldOutDto = z.object({ soldOut: z.boolean(), untilMinutes: z.number().int().positive().optional() });
const ModGroupDto = z.object({ name: z.string().min(1), minSelect: z.number().int().min(0).optional(), maxSelect: z.number().int().min(1).optional(), required: z.boolean().optional(), options: z.array(z.object({ name: z.string().min(1), priceCents: z.number().int().min(0).optional() })) });
const ImportDto = z.object({ name: z.string(), brandId: z.string().uuid().optional(), categories: z.array(z.object({ name: z.string(), items: z.array(z.object({ name: z.string(), priceCents: z.number().int(), description: z.string().optional(), allergens: z.array(z.string()).optional(), posExternalId: z.string().optional(), stationCode: z.string().optional() })) })) });

@ApiTags('05 Menu & offer catalog')
@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

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
