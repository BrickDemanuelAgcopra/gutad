/** 6.4 / 6.8 — a brand's menu sells only while its rights are active, inside its territories and through authorized channels. */
export interface BrandRights {
  rightsStatus: string;
  contentRightsOk: boolean;
  contractEnd: Date | null;
  territoryRegionIds: string[];
  authorizedChannels: string[];
}

export function brandSellable(b: BrandRights, regionId: string | null | undefined, channel?: string | null, at = new Date()): boolean {
  return brandBlockReason(b, regionId, channel, at) === null;
}

export function brandBlockReason(b: BrandRights, regionId: string | null | undefined, channel?: string | null, at = new Date()): string | null {
  if (b.rightsStatus !== 'ACTIVE') return `rights ${b.rightsStatus.toLowerCase()}`;
  if (!b.contentRightsOk) return 'content rights not cleared';
  if (b.contractEnd && b.contractEnd < at) return 'contract ended';
  if (b.territoryRegionIds.length && (!regionId || !b.territoryRegionIds.includes(regionId))) return 'outside licensed territory';
  if (channel && b.authorizedChannels.length && !b.authorizedChannels.includes(channel)) return `not authorized for ${channel.toLowerCase()}`;
  return null;
}
