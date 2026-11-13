/**
 * Plan catalog contracts and fee resolution, shared by the API (charging), the admin editor (preview) and the
 * public pricing page (plain-language descriptions), so all three always agree.
 */

export type ProductLine = 'ORDERING' | 'RESERVATIONS' | 'SUITE';
export type FeeType = 'COMMISSION' | 'COVER_FEE' | 'PREPAID_SERVICE_FEE' | 'PROCESSING' | 'DELIVERY_SUBSIDY' | 'LOGISTICS_FEE';
/** NETWORK = Gutad-sourced demand (marketplace app/site and partner referrals). */
export type FeeChannel = 'ANY' | 'NETWORK' | 'MARKETPLACE' | 'PARTNER' | 'DIRECT' | 'WIDGET' | 'QR';
export type FeeFulfillment = 'ANY' | 'DELIVERY' | 'PICKUP' | 'DINE_IN';

export interface FeeRuleDto {
  type: FeeType;
  channel: FeeChannel | string;
  fulfillment: FeeFulfillment | string;
  bps: number;
  cents: number;
  capCents?: number | null;
  label?: string | null;
}

export interface PlanFeatureDto {
  key: string;
  name: string;
  kind: 'BOOLEAN' | 'LIMIT';
  enabled: boolean;
  limitValue: number | null;
}

export interface PublicPlanDto {
  code: string;
  name: string;
  productLine: ProductLine;
  tagline: string | null;
  description: string | null;
  highlight: boolean;
  version: number;
  subscriptionCents: number;
  interval: 'MONTH' | 'YEAR';
  perLocation: boolean;
  setupFeeCents: number;
  trialDays: number;
  fees: FeeRuleDto[];
  features: PlanFeatureDto[];
}

export const PRODUCT_LINES: { key: ProductLine; label: string; blurb: string }[] = [
  { key: 'ORDERING', label: 'Ordering', blurb: 'Pickup and delivery on the Gutad marketplace and your own ordering link.' },
  { key: 'RESERVATIONS', label: 'Reservations', blurb: 'Table bookings, waitlist, experiences and private events.' },
  { key: 'SUITE', label: 'Full suite', blurb: 'Ordering and reservations together, with ads and every feature.' },
];

export const FEE_TYPES: { key: FeeType; label: string; unit: 'bps' | 'cents' | 'both' }[] = [
  { key: 'COMMISSION', label: 'Commission', unit: 'bps' },
  { key: 'COVER_FEE', label: 'Cover fee (per seated guest)', unit: 'cents' },
  { key: 'PREPAID_SERVICE_FEE', label: 'Prepaid booking fee', unit: 'bps' },
  { key: 'PROCESSING', label: 'Card processing', unit: 'both' },
  { key: 'DELIVERY_SUBSIDY', label: 'Delivery subsidy (Gutad pays, per order)', unit: 'cents' },
  { key: 'LOGISTICS_FEE', label: 'Logistics fee (per delivery)', unit: 'cents' },
];

export const FEE_CHANNELS: { key: FeeChannel; label: string }[] = [
  { key: 'ANY', label: 'Any channel' },
  { key: 'NETWORK', label: 'Gutad network (marketplace + partners)' },
  { key: 'MARKETPLACE', label: 'Gutad marketplace' },
  { key: 'PARTNER', label: 'Partner referrals' },
  { key: 'DIRECT', label: 'Your own link / site' },
  { key: 'WIDGET', label: 'Booking widget' },
  { key: 'QR', label: 'QR code' },
];

export const FEE_FULFILLMENTS: { key: FeeFulfillment; label: string }[] = [
  { key: 'ANY', label: 'Any' },
  { key: 'DELIVERY', label: 'Delivery' },
  { key: 'PICKUP', label: 'Pickup' },
  { key: 'DINE_IN', label: 'Dine-in / reservations' },
];

const NETWORK_CHANNELS = ['MARKETPLACE', 'PARTNER'];

function channelScore(ruleChannel: string, channel: string): number {
  if (ruleChannel === channel) return 3;
  if (ruleChannel === 'NETWORK' && NETWORK_CHANNELS.includes(channel)) return 2;
  if (ruleChannel === 'ANY') return 1;
  return 0;
}

function fulfillmentScore(ruleFulfillment: string, fulfillment: string | undefined): number {
  if (fulfillment && ruleFulfillment === fulfillment) return 2;
  if (ruleFulfillment === 'ANY') return 1;
  return 0;
}

/**
 * The rule that applies to an event: matching type, then the most specific channel, then the most specific
 * fulfillment. Returns undefined when no rule matches (callers fall back to platform defaults).
 */
export function resolveFee(rules: FeeRuleDto[], type: FeeType, channel: string, fulfillment?: string): FeeRuleDto | undefined {
  let best: FeeRuleDto | undefined;
  let bestScore = 0;
  for (const r of rules) {
    if (r.type !== type) continue;
    const c = channelScore(r.channel, channel);
    const f = fulfillmentScore(r.fulfillment, fulfillment);
    if (!c || !f) continue;
    const score = c * 10 + f;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** Fee amount in cents for a base amount (percentage part + fixed part, capped). */
export function feeAmount(rule: FeeRuleDto | undefined, baseCents: number): number {
  if (!rule) return 0;
  const raw = Math.round((baseCents * rule.bps) / 10_000) + rule.cents;
  return rule.capCents != null ? Math.min(raw, rule.capCents) : raw;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? (bps % 10 ? 2 : 1) : 0)}%`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const channelText: Record<string, string> = { ANY: '', NETWORK: 'Gutad marketplace', MARKETPLACE: 'Gutad marketplace', PARTNER: 'partner', DIRECT: 'your own site', WIDGET: 'booking widget', QR: 'QR' };
const fulfillmentText: Record<string, string> = { ANY: '', DELIVERY: 'delivery', PICKUP: 'pickup', DINE_IN: 'dine-in' };

/** Plain-language one-liner, e.g. "15% on Gutad marketplace delivery" or "$1.50 per Gutad marketplace cover". */
export function describeFee(r: FeeRuleDto): string {
  if (r.label) return r.label;
  const where = [channelText[r.channel] ?? r.channel.toLowerCase(), fulfillmentText[r.fulfillment] ?? r.fulfillment.toLowerCase()].filter(Boolean).join(' ');
  const amount = r.bps && r.cents ? `${pct(r.bps)} + ${usd(r.cents)}` : r.bps ? pct(r.bps) : usd(r.cents);
  const cap = r.capCents != null ? ` (max ${usd(r.capCents)})` : '';
  switch (r.type) {
    case 'COMMISSION':
      return `${amount} on ${where || 'all'} orders${cap}`;
    case 'COVER_FEE':
      return `${amount} per ${where ? where + ' ' : ''}cover`;
    case 'PREPAID_SERVICE_FEE':
      return `${amount} on prepaid bookings${where ? ' via ' + where : ''}${cap}`;
    case 'PROCESSING':
      return `${amount} card processing${where ? ' on ' + where : ''}`;
    case 'DELIVERY_SUBSIDY':
      return `Gutad covers ${amount} of delivery per order`;
    case 'LOGISTICS_FEE':
      return `${amount} logistics fee per delivery`;
    default:
      return `${r.type}: ${amount}`;
  }
}
