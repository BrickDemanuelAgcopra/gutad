import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DiscoveryService } from './discovery.service';

const SearchDto = z.object({
  q: z.string().optional(),
  city: z.string().optional(),
  cuisine: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radiusKm: z.coerce.number().optional(),
  service: z.enum(['pickup', 'delivery', 'reservations', 'events', 'catering']).optional(),
  openNow: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  seller: z.enum(['gutad', 'merchants']).optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});

@ApiTags('04 Local discovery')
@Public()
@Controller('public')
export class DiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get('search') search(@Query(zod(SearchDto)) q: z.infer<typeof SearchDto>) { return this.svc.search(q); }
  @Get('locations/:slug') page(@Param('slug') slug: string) { return this.svc.locationPage(slug); }
  @Get('locations/:id/serviceability') serviceability(@Param('id') id: string, @Query('lat') lat: string, @Query('lng') lng: string) {
    return this.svc.serviceability(id, Number(lat), Number(lng));
  }
  @Post('sponsored/:id/click') click(@Param('id') id: string) { return this.svc.clickSponsored(id); }
}
