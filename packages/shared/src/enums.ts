// Mirrors the Prisma enums in apps/api/prisma/schema.prisma. Keep in sync.

export const Channel = {
  MARKETPLACE: 'MARKETPLACE',
  DIRECT: 'DIRECT',
  WIDGET: 'WIDGET',
  QR: 'QR',
  PARTNER: 'PARTNER',
  PHONE: 'PHONE',
  WALK_IN: 'WALK_IN',
  CAMPUS: 'CAMPUS',
  CORPORATE: 'CORPORATE',
  API: 'API',
  KIOSK: 'KIOSK',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const FulfillmentType = {
  PICKUP: 'PICKUP',
  DELIVERY: 'DELIVERY',
  DINE_IN: 'DINE_IN',
  SHIPMENT: 'SHIPMENT',
  CATERING: 'CATERING',
} as const;
export type FulfillmentType = (typeof FulfillmentType)[keyof typeof FulfillmentType];

export const OrderStatus = {
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  COLLECTED: 'COLLECTED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELED: 'CANCELED',
  PARTIALLY_FULFILLED: 'PARTIALLY_FULFILLED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PaymentStatus = {
  REQUIRES_ACTION: 'REQUIRES_ACTION',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  SETTLED: 'SETTLED',
  VOIDED: 'VOIDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
  DISPUTED: 'DISPUTED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const ReservationStatus = {
  HELD: 'HELD',
  CONFIRMED: 'CONFIRMED',
  ARRIVED: 'ARRIVED',
  SEATED: 'SEATED',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  CANCELED: 'CANCELED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

export const DeliveryStatus = {
  QUOTED: 'QUOTED',
  REQUESTED: 'REQUESTED',
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  UNASSIGNED: 'UNASSIGNED',
  CANCELED: 'CANCELED',
  FAILED: 'FAILED',
  RETURNED: 'RETURNED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const PayoutStatus = {
  ACCRUED: 'ACCRUED',
  ELIGIBLE: 'ELIGIBLE',
  SUBMITTED: 'SUBMITTED',
  PAID: 'PAID',
  RECONCILED: 'RECONCILED',
  HELD: 'HELD',
  FAILED: 'FAILED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const Role = {
  CUSTOMER: 'CUSTOMER',
  MERCHANT_OWNER: 'MERCHANT_OWNER',
  MERCHANT_MANAGER: 'MERCHANT_MANAGER',
  MERCHANT_STAFF: 'MERCHANT_STAFF',
  HOST: 'HOST',
  KITCHEN: 'KITCHEN',
  PACKER: 'PACKER',
  DISPATCHER: 'DISPATCHER',
  DRIVER: 'DRIVER',
  SUPPORT: 'SUPPORT',
  FINANCE: 'FINANCE',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  ORG_MEMBER: 'ORG_MEMBER',
  EXECUTIVE: 'EXECUTIVE',
  OPERATIONS: 'OPERATIONS',
  CULINARY: 'CULINARY',
  MARKETING: 'MARKETING',
  IT: 'IT',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
