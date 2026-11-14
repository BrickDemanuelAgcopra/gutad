/** Payments operations, settlement and accounting contracts shared by API, web and mobile (Phase H). */

export const PAYMENT_METHOD_TYPES = ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'CREDITS', 'LOYALTY', 'GIFT_CARD'] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodType, string> = { CARD: 'Card', APPLE_PAY: 'Apple Pay', GOOGLE_PAY: 'Google Pay', CREDITS: 'Gutad credits', LOYALTY: 'Loyalty points', GIFT_CARD: 'Gift card' };

/** Setting `payments.methods` (18.2): enabled methods by default, per channel and per region (region id). */
export interface PaymentMethodsConfig { default: PaymentMethodType[]; byChannel: Record<string, PaymentMethodType[]>; byRegion: Record<string, PaymentMethodType[]> }
export const DEFAULT_PAYMENT_METHODS: PaymentMethodsConfig = { default: ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'CREDITS', 'LOYALTY'], byChannel: { PHONE: ['CARD'], WALK_IN: ['CARD'] }, byRegion: {} };
export function enabledMethods(cfg: PaymentMethodsConfig, channel?: string | null, regionId?: string | null): PaymentMethodType[] {
  const base = (regionId && cfg.byRegion[regionId]) || cfg.default;
  const ch = channel ? cfg.byChannel[channel] : undefined;
  return ch ? base.filter((m) => ch.includes(m)) : base;
}

/** Setting `finance.controls`. */
export interface FinanceControls { bankChangeHoldDays: number; maxCaptureRetries: number; disputeEvidenceDays: number; manualAdjustmentApprovalCents: number }
export const DEFAULT_FINANCE_CONTROLS: FinanceControls = { bankChangeHoldDays: 3, maxCaptureRetries: 3, disputeEvidenceDays: 7, manualAdjustmentApprovalCents: 50000 };

/** Test cards for the mock processor (18.9: the card number itself is never typed into Gutad). */
export const TEST_CARDS = [
  { token: 'mock_pm_4242', label: 'Visa •••• 4242 (succeeds)', brand: 'visa', last4: '4242' },
  { token: 'mock_pm_4444', label: 'Mastercard •••• 4444 (succeeds)', brand: 'mastercard', last4: '4444' },
  { token: 'mock_pm_0002', label: 'Visa •••• 0002 (declined)', brand: 'visa', last4: '0002' },
] as const;

/** 19.2 statement categories, classified from ledger memos and accounts. */
export const STATEMENT_CATEGORIES = ['SALES', 'TIPS', 'COMMISSION', 'PROMOTIONS', 'REFUNDS', 'CREDITS', 'COVER_FEES', 'DELIVERY', 'ROYALTIES', 'ADJUSTMENTS', 'DISPUTES', 'PAYOUTS', 'OTHER'] as const;
export type StatementCategory = (typeof STATEMENT_CATEGORIES)[number];
export function classifyMerchantEntry(memo: string | null | undefined): StatementCategory {
  const m = (memo || '').toLowerCase();
  if (m.startsWith('payout')) return 'PAYOUTS';
  if (m.includes('food + tax')) return 'SALES';
  if (m.includes('tip')) return 'TIPS';
  if (m.includes('commission')) return 'COMMISSION';
  if (m.includes('promotion') || m.includes('coupon') || m.includes('discount')) return 'PROMOTIONS';
  if (m.includes('refund')) return 'REFUNDS';
  if (m.includes('credit')) return 'CREDITS';
  if (m.includes('cover fee')) return 'COVER_FEES';
  if (m.includes('delivery') || m.includes('cancellation fee')) return 'DELIVERY';
  if (m.includes('royalt')) return 'ROYALTIES';
  if (m.includes('dispute') || m.includes('chargeback')) return 'DISPUTES';
  if (m.includes('adjust') || m.includes('re-credit') || m.includes('responsibility')) return 'ADJUSTMENTS';
  return 'OTHER';
}

/** 20.1 default chart of accounts (a proposed mapping; it makes no claim about Gutad's accounting software). */
export const DEFAULT_GL_MAP: Record<string, { code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' }> = {
  BANK: { code: '1000', name: 'Operating bank', type: 'ASSET' },
  PROCESSOR_CLEARING: { code: '1100', name: 'Processor clearing', type: 'ASSET' },
  CUSTOMER_RECEIVABLE: { code: '1200', name: 'Accounts receivable', type: 'ASSET' },
  DISPUTE_RECEIVABLE: { code: '1250', name: 'Disputed funds receivable', type: 'ASSET' },
  INVENTORY: { code: '1300', name: 'Inventory', type: 'ASSET' },
  MERCHANT_PAYABLE: { code: '2000', name: 'Merchant payables', type: 'LIABILITY' },
  DRIVER_PAYABLE: { code: '2010', name: 'Courier payables', type: 'LIABILITY' },
  PROVIDER_PAYABLE: { code: '2020', name: 'Delivery provider payables', type: 'LIABILITY' },
  SUPPLIER_PAYABLE: { code: '2030', name: 'Accounts payable (suppliers)', type: 'LIABILITY' },
  TAX_PAYABLE: { code: '2100', name: 'Sales tax payable', type: 'LIABILITY' },
  CUSTOMER_CREDIT_LIABILITY: { code: '2200', name: 'Customer credit liability', type: 'LIABILITY' },
  DEPOSIT_LIABILITY: { code: '2210', name: 'Customer deposits', type: 'LIABILITY' },
  DEFERRED_REVENUE: { code: '2300', name: 'Deferred revenue', type: 'LIABILITY' },
  PLATFORM_REVENUE_COMMISSION: { code: '4000', name: 'Commission revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_SERVICE_FEE: { code: '4010', name: 'Service fee revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_DELIVERY: { code: '4020', name: 'Delivery revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_SUBSCRIPTION: { code: '4030', name: 'Subscription revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_MEMBERSHIP: { code: '4040', name: 'Membership revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_COVER_FEE: { code: '4050', name: 'Cover fee revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_ADS: { code: '4060', name: 'Advertising revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_REFERRAL: { code: '4070', name: 'Referral revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_B2B: { code: '4080', name: 'B2B revenue', type: 'REVENUE' },
  PLATFORM_REVENUE_FOOD_SALES: { code: '4090', name: 'Food sales (own kitchens)', type: 'REVENUE' },
  PLATFORM_REVENUE_BREAKAGE: { code: '4100', name: 'Credit breakage', type: 'REVENUE' },
  PLATFORM_EXPENSE_COGS: { code: '5000', name: 'Cost of goods sold', type: 'EXPENSE' },
  PLATFORM_EXPENSE_PROCESSING: { code: '5100', name: 'Payment processing', type: 'EXPENSE' },
  PLATFORM_EXPENSE_DELIVERY_SUBSIDY: { code: '5200', name: 'Delivery cost', type: 'EXPENSE' },
  PLATFORM_EXPENSE_PROMOTION: { code: '5300', name: 'Promotions', type: 'EXPENSE' },
  PLATFORM_EXPENSE_REFUND: { code: '5400', name: 'Refunds & goodwill', type: 'EXPENSE' },
  PLATFORM_EXPENSE_ROYALTY: { code: '5500', name: 'Royalties', type: 'EXPENSE' },
  PLATFORM_ADJUSTMENTS: { code: '5900', name: 'Settlement adjustments', type: 'EXPENSE' },
};

/** 20.2 P&L lines from ledger accounts. */
export const PNL_LINES: { key: string; label: string; accounts: string[]; sign: 1 | -1 }[] = [
  { key: 'commission', label: 'Commission', accounts: ['PLATFORM_REVENUE_COMMISSION'], sign: 1 },
  { key: 'fees', label: 'Service & delivery fees', accounts: ['PLATFORM_REVENUE_SERVICE_FEE', 'PLATFORM_REVENUE_DELIVERY'], sign: 1 },
  { key: 'subscriptions', label: 'Subscriptions & memberships', accounts: ['PLATFORM_REVENUE_SUBSCRIPTION', 'PLATFORM_REVENUE_MEMBERSHIP'], sign: 1 },
  { key: 'other_revenue', label: 'Other revenue', accounts: ['PLATFORM_REVENUE_COVER_FEE', 'PLATFORM_REVENUE_ADS', 'PLATFORM_REVENUE_REFERRAL', 'PLATFORM_REVENUE_B2B', 'PLATFORM_REVENUE_FOOD_SALES', 'PLATFORM_REVENUE_BREAKAGE'], sign: 1 },
  { key: 'cogs', label: 'Cost of goods', accounts: ['PLATFORM_EXPENSE_COGS'], sign: -1 },
  { key: 'delivery', label: 'Delivery cost', accounts: ['PLATFORM_EXPENSE_DELIVERY_SUBSIDY'], sign: -1 },
  { key: 'processing', label: 'Payment processing', accounts: ['PLATFORM_EXPENSE_PROCESSING'], sign: -1 },
  { key: 'promotions', label: 'Promotions', accounts: ['PLATFORM_EXPENSE_PROMOTION'], sign: -1 },
  { key: 'refunds', label: 'Refunds & goodwill', accounts: ['PLATFORM_EXPENSE_REFUND'], sign: -1 },
  { key: 'royalties', label: 'Royalties', accounts: ['PLATFORM_EXPENSE_ROYALTY'], sign: -1 },
  { key: 'adjustments', label: 'Adjustments', accounts: ['PLATFORM_ADJUSTMENTS'], sign: -1 },
];

/** 20.6 aging buckets in days. */
export const AGING_BUCKETS = [{ key: 'current', label: 'Not due', max: 0 }, { key: 'd30', label: '1–30', max: 30 }, { key: 'd60', label: '31–60', max: 60 }, { key: 'd90', label: '61–90', max: 90 }, { key: 'd90p', label: '90+', max: Infinity }] as const;
export const agingBucket = (dueAt: Date | string, now = new Date()) => { const days = Math.floor((now.getTime() - new Date(dueAt).getTime()) / 86400_000); return AGING_BUCKETS.find((b) => days <= b.max)!.key; };

/** 20.7 month-end close checklist. */
export const CLOSE_CHECKLIST = [
  { key: 'ledger_balanced', label: 'Every journal batch balances', auto: true },
  { key: 'unmatched_resolved', label: 'Unmatched processor, provider and bank items resolved', auto: true },
  { key: 'payouts_reconciled', label: 'Paid payouts reconciled to the bank', auto: true },
  { key: 'disputes_reviewed', label: 'Disputes past their evidence deadline answered', auto: true },
  { key: 'deferral_trueup', label: 'Deferred revenue trued up for the month', auto: true },
  { key: 'breakage_posted', label: 'Expired credits posted as breakage', auto: true },
  { key: 'journal_exported', label: 'Journal exported to the general ledger', auto: false },
  { key: 'reviewed', label: 'P&L and liabilities reviewed by finance', auto: false },
] as const;
