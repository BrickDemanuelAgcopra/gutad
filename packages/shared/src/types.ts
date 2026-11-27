import type {
  Channel,
  DeliveryStatus,
  FulfillmentType,
  OrderStatus,
  PaymentStatus,
  ReservationStatus,
  Role,
} from './enums';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  roles: Role[];
  merchantIds: string[];
  locationIds: string[];
  /** member roles per organization the person belongs to */
  memberRoles?: Record<string, Role[]>;
  /** admin-console permissions (staff only), already capped by scope and sensitivity */
  permissions?: string[];
  /** active emergency (break-glass) elevation */
  elevated?: { roles: Role[]; until: string; grantId: string } | null;
  /** active audited support session ("view as merchant") */
  supportAccess?: { organizationId: string; until: string; readOnly: boolean; grantId: string } | null;
  mfaEnabled?: boolean;
  /** true when the person's role requires MFA and they have not enrolled yet */
  mfaSetupRequired?: boolean;
  /** platform staff (built-in or custom roles, or a service account) */
  staff?: boolean;
  /** IAM roles held right now (keys and names) */
  accessRoles?: { id: string; key: string; name: string; primary: boolean; endsAt: string | null }[];
  /** matrix permissions (`resource:action`) held right now */
  finePermissions?: string[];
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/** Login answer when the account has MFA: call `/auth/mfa/verify` with the challenge and a code. */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
}

export interface LocationSummary {
  id: string;
  merchantId: string;
  slug: string;
  name: string;
  cuisine: string[];
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  lat: number | null;
  lng: number | null;
  heroImageUrl: string | null;
  rating: number | null;
  ratingCount: number;
  acceptsPickup: boolean;
  acceptsDelivery: boolean;
  acceptsReservations: boolean;
  acceptsEvents: boolean;
  isOpenNow: boolean;
  sponsored?: boolean;
  distanceKm?: number | null;
  /** Prepared by Gutad's own culinary team at a Gutad food hall ("Made at Gutad", green G badge). */
  platformOperated?: boolean;
  /** Set when a search result is one brand served from a Made at Gutad food hall. */
  brand?: BrandSummary | null;
  /** Name of the food hall the brand is prepared at (brand results only). */
  foodHallName?: string | null;
  /** Sold by Gutad itself (first-party); `sellerLabel` is the label to show, e.g. "Sold by Gutad". */
  firstParty?: boolean;
  sellerLabel?: string | null;
}

export interface BrandSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
}

export interface MenuItemDto {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  allergens: string[];
  soldOut: boolean;
  modifierGroups: ModifierGroupDto[];
}

export interface ModifierGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  options: { id: string; name: string; priceCents: number; soldOut: boolean }[];
}

export interface MenuCategoryDto {
  id: string;
  name: string;
  items: MenuItemDto[];
}

export interface MenuDto {
  id: string;
  name: string;
  locationId: string;
  categories: MenuCategoryDto[];
}

export interface CartLineInput {
  menuItemId: string;
  quantity: number;
  modifierOptionIds?: string[];
  specialInstructions?: string;
}

export interface QuoteRequest {
  locationId: string;
  channel: Channel;
  fulfillmentType: FulfillmentType;
  lines: CartLineInput[];
  scheduledFor?: string | null;
  tipCents?: number;
  promoCode?: string;
  deliveryAddress?: AddressInput;
}

export interface AddressInput {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country?: string;
  lat?: number;
  lng?: number;
  instructions?: string;
}

export interface QuoteLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  lineTotalCents: number;
  modifierOptionIds: string[];
  specialInstructions?: string;
}

export interface Quote {
  id: string;
  locationId: string;
  channel: Channel;
  fulfillmentType: FulfillmentType;
  currency: string;
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  serviceFeeCents: number;
  deliveryFeeCents: number;
  /** delivery fee details: the standard fee, why it is free and how much more unlocks the store's free delivery */
  delivery?: QuoteDelivery | null;
  tipCents: number;
  totalCents: number;
  promiseAt: string | null;
  expiresAt: string;
  deliveryQuoteId?: string | null;
  warnings: string[];
  /** 25.1 promotions applied (automatic offers and codes) */
  promotions?: import('./growth').AppliedPromotion[];
  creditsCents?: number;
  loyaltyCents?: number;
  giftCents?: number;
  /** 11.6 payment mix: credits, points and gift balance first, the card pays the rest */
  paymentMix?: import('./growth').PaymentMix;
}

export interface OrderDto {
  id: string;
  number: string;
  status: OrderStatus;
  channel: Channel;
  fulfillmentType: FulfillmentType;
  locationId: string;
  locationName?: string;
  currency: string;
  subtotalCents: number;
  totalCents: number;
  tipCents: number;
  promiseAt: string | null;
  readyAt: string | null;
  pickupCode: string | null;
  lines: { name: string; quantity: number; lineTotalCents: number }[];
  payment?: { status: PaymentStatus; capturedCents: number; refundedCents: number } | null;
  delivery?: { status: DeliveryStatus; eta: string | null; trackingUrl: string | null } | null;
  createdAt: string;
}

export interface AvailabilitySlot {
  time: string;
  partySize: number;
  tableIds: string[];
}

export interface ReservationDto {
  id: string;
  status: ReservationStatus;
  locationId: string;
  partySize: number;
  startAt: string;
  endAt: string;
  guestName: string;
  confirmationCode: string;
  policy: { cancellationHours: number; noShowFeeCents: number; depositCents: number };
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  error?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Delivery fee on a quote: `freeReason` GUTAD (Gutad-wide offer), PROMO, MEMBERSHIP or STORE (the store's offer). */
export interface DeliveryOptionQuote { id: 'STANDARD' | 'PRIORITY'; feeCents: number; etaMinutes: number }
export interface QuoteDelivery { option?: 'STANDARD' | 'PRIORITY'; options?: DeliveryOptionQuote[]; priorityFeeCents?: number; lateGraceMinutes?: number; standardFeeCents: number; feeCents: number; freeReason: 'GUTAD' | 'PROMO' | 'MEMBERSHIP' | 'STORE' | null; storeFreeMinCents: number | null; amountToFreeCents: number; fleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM' }

/** What a diner reads about the delivery fee, shared by web and mobile checkout. */
export function deliveryFeeNotes(d: QuoteDelivery | null | undefined, storeName: string): { free: boolean; note: string | null; nudge: string | null } {
  if (!d) return { free: false, note: null, nudge: null };
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const free = d.feeCents - (d.priorityFeeCents ?? 0) === 0;
  const why = d.freeReason === 'STORE' ? `Free delivery from ${storeName}` : d.freeReason === 'GUTAD' ? 'Free delivery from Gutad' : d.freeReason === 'MEMBERSHIP' ? 'Free delivery with your membership' : d.freeReason === 'PROMO' ? 'Free delivery with your promo' : 'Free delivery';
  return {
    free,
    note: free ? (d.standardFeeCents > 0 ? `${why} (standard ${usd(d.standardFeeCents)})` : why) : `Standard delivery${d.fleet === 'MERCHANT' ? ` by ${storeName}'s own courier` : ''}`,
    nudge: !free && d.amountToFreeCents > 0 ? `Add ${usd(d.amountToFreeCents)} more for free delivery from ${storeName}` : null,
  };
}
