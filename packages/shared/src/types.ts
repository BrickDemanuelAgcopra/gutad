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
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
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
  tipCents: number;
  totalCents: number;
  promiseAt: string | null;
  expiresAt: string;
  deliveryQuoteId?: string | null;
  warnings: string[];
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
