import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', [
  'CUSTOMER',
  'MERCHANT_OWNER',
  'MERCHANT_MANAGER',
  'MERCHANT_STAFF',
  'HOST',
  'KITCHEN',
  'PACKER',
  'DISPATCHER',
  'DRIVER',
  'SUPPORT',
  'FINANCE',
  'PLATFORM_ADMIN',
  'ORG_MEMBER',
  'EXECUTIVE',
  'OPERATIONS',
  'CULINARY',
  'MARKETING',
  'IT',
]);

export const channelEnum = pgEnum('channel', [
  'MARKETPLACE',
  'DIRECT',
  'WIDGET',
  'QR',
  'PARTNER',
  'PHONE',
  'WALK_IN',
  'CAMPUS',
  'CORPORATE',
  'API',
  'KIOSK',
]);

export const fulfillmentTypeEnum = pgEnum('fulfillment_type', [
  'PICKUP',
  'DELIVERY',
  'DINE_IN',
  'SHIPMENT',
  'CATERING',
]);

export const orderStatusEnum = pgEnum('order_status', [
  'SUBMITTED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COLLECTED',
  'COMPLETED',
  'REJECTED',
  'CANCELED',
  'PARTIALLY_FULFILLED',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'REQUIRES_ACTION',
  'AUTHORIZED',
  'CAPTURED',
  'SETTLED',
  'VOIDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
]);

export const reservationStatusEnum = pgEnum('reservation_status', [
  'HELD',
  'CONFIRMED',
  'ARRIVED',
  'SEATED',
  'COMPLETED',
  'EXPIRED',
  'CANCELED',
  'NO_SHOW',
]);

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'QUOTED',
  'REQUESTED',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'QUOTE_EXPIRED',
  'UNASSIGNED',
  'CANCELED',
  'FAILED',
  'RETURNED',
]);

export const deliveryFleetEnum = pgEnum('delivery_fleet', ['MERCHANT', 'PARTNER', 'PLATFORM']);

export const payoutStatusEnum = pgEnum('payout_status', [
  'ACCRUED',
  'ELIGIBLE',
  'SUBMITTED',
  'PAID',
  'RECONCILED',
  'HELD',
  'FAILED',
]);

export const ledgerAccountEnum = pgEnum('ledger_account', [
  'CUSTOMER_RECEIVABLE',
  'PROCESSOR_CLEARING',
  'MERCHANT_PAYABLE',
  'DRIVER_PAYABLE',
  'PROVIDER_PAYABLE',
  'TAX_PAYABLE',
  'PLATFORM_REVENUE_COMMISSION',
  'PLATFORM_REVENUE_SUBSCRIPTION',
  'PLATFORM_REVENUE_COVER_FEE',
  'PLATFORM_REVENUE_SERVICE_FEE',
  'PLATFORM_REVENUE_DELIVERY',
  'PLATFORM_REVENUE_ADS',
  'PLATFORM_REVENUE_MEMBERSHIP',
  'PLATFORM_REVENUE_REFERRAL',
  'PLATFORM_REVENUE_B2B',
  'PLATFORM_REVENUE_FOOD_SALES',
  'PLATFORM_EXPENSE_PROCESSING',
  'PLATFORM_EXPENSE_DELIVERY_SUBSIDY',
  'PLATFORM_EXPENSE_PROMOTION',
  'PLATFORM_EXPENSE_REFUND',
  'PLATFORM_EXPENSE_ROYALTY',
  'PLATFORM_EXPENSE_COGS',
  'CUSTOMER_CREDIT_LIABILITY',
  'DEPOSIT_LIABILITY',
  'BANK',
  'DISPUTE_RECEIVABLE',
  'DEFERRED_REVENUE',
  'PLATFORM_REVENUE_BREAKAGE',
  'SUPPLIER_PAYABLE',
  'INVENTORY',
  'PLATFORM_ADJUSTMENTS',
  'GIFT_CARD_LIABILITY',
]);

export const waitlistStatusEnum = pgEnum('waitlist_status', [
  'WAITING',
  'NOTIFIED',
  'SEATED',
  'EXPIRED',
  'LEFT',
]);

export const eventInquiryStatusEnum = pgEnum('event_inquiry_status', [
  'INQUIRY',
  'QUALIFIED',
  'PROPOSED',
  'CONTRACTED',
  'DEPOSIT_PAID',
  'CONFIRMED',
  'HELD',
  'COMPLETED',
  'CANCELED',
  'EXPIRED',
]);

export const shipmentStatusEnum = pgEnum('shipment_status', [
  'RESERVED',
  'PICKING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'FAILED',
  'RETURNED',
]);

export const incidentStatusEnum = pgEnum('incident_status', [
  'OPEN',
  'INVESTIGATING',
  'RESOLVED',
  'APPEALED',
  'CLOSED',
]);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'EMAIL',
  'SMS',
  'PUSH',
  'IN_APP',
]);

export const notificationKindEnum = pgEnum('notification_kind', ['TRANSACTIONAL', 'MARKETING']);

export const merchantStatusEnum = pgEnum('merchant_status', [
  'PROSPECT',
  'CLAIMED',
  'VERIFIED',
  'ONBOARDING',
  'LIVE',
  'PAUSED',
  'SUSPENDED',
  'OFFBOARDED',
]);

export const programTypeEnum = pgEnum('program_type', ['CAMPUS', 'B2B_OPERATOR', 'CREATOR_BRAND']);

export const integrationTypeEnum = pgEnum('integration_type', [
  'POS',
  'PAYMENT',
  'DELIVERY',
  'MESSAGING',
  'MAPS',
  'PRINTER',
  'TABLET',
  'KDS',
  'PARTNER_API',
]);
