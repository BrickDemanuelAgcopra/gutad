import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * 9.5-X — external tax engines behind the quote's tax calculation.
 * The built-in rate table (tax_rates → location rate) stays the default; `TAX_PROVIDER=taxjar|avalara` (+ keys) switches
 * to a provider. Any provider error falls back to the built-in result with a warning. Results are cached by cart signature.
 * Nothing touches the network unless a provider is configured with credentials.
 */
export interface TaxLine { category: string; rateBps: number; taxableCents: number; taxCents: number }
export interface TaxAddress { line1: string; city: string; region: string; postalCode: string; country?: string }
export interface TaxRequest {
  locationId: string;
  currency: string;
  from: TaxAddress;
  to: TaxAddress;
  /** taxable amount per tax category after the discount share (from the built-in calculation) */
  lines: { category: string; taxableCents: number }[];
}
export interface TaxResult { taxCents: number; lines: TaxLine[] }
export interface TaxProvider {
  readonly name: 'taxjar' | 'avalara' | 'mock';
  calculate(req: TaxRequest): Promise<TaxResult>;
}

const cents = (dollars: number) => Math.round(dollars * 100);
const rateOf = (taxCents: number, taxable: number) => (taxable ? Math.round((taxCents * 10000) / taxable) : 0);

/** Our tax categories → provider product tax codes (overridable with TAXJAR_CODES / AVALARA_CODES as JSON). */
const TAXJAR_CODES: Record<string, string> = { PREPARED_FOOD: '41000', GROCERY: '40030', ALCOHOL: '50202', BEVERAGE: '40050', EXEMPT: '99999' };
const AVALARA_CODES: Record<string, string> = { PREPARED_FOOD: 'PF160021', GROCERY: 'PF050001', ALCOHOL: 'PF140110', BEVERAGE: 'PF120000', EXEMPT: 'NT' };
const codes = (env: string | undefined, base: Record<string, string>) => { try { return { ...base, ...(env ? (JSON.parse(env) as Record<string, string>) : {}) }; } catch { return base; } };

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(t);
  }
}

export class TaxJarProvider implements TaxProvider {
  readonly name = 'taxjar' as const;
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.taxjar.com/v2', private readonly timeoutMs = 3000) {}
  async calculate(req: TaxRequest): Promise<TaxResult> {
    const map = codes(process.env.TAXJAR_CODES, TAXJAR_CODES);
    const body = {
      from_country: req.from.country || 'US', from_zip: req.from.postalCode, from_state: req.from.region, from_city: req.from.city, from_street: req.from.line1,
      to_country: req.to.country || 'US', to_zip: req.to.postalCode, to_state: req.to.region, to_city: req.to.city, to_street: req.to.line1,
      shipping: 0,
      amount: req.lines.reduce((a, l) => a + l.taxableCents, 0) / 100,
      line_items: req.lines.map((l) => ({ id: l.category, quantity: 1, unit_price: l.taxableCents / 100, ...(map[l.category] ? { product_tax_code: map[l.category] } : {}) })),
    };
    const json = await postJson(`${this.baseUrl}/taxes`, { Authorization: `Bearer ${this.apiKey}` }, body, this.timeoutMs);
    const tax = json.tax as { amount_to_collect?: number; breakdown?: { line_items?: { id: string; tax_collectable: number; taxable_amount: number }[] } } | undefined;
    if (!tax || typeof tax.amount_to_collect !== 'number') throw new Error('TaxJar response missing tax.amount_to_collect');
    const items = tax.breakdown?.line_items || [];
    const lines = req.lines.map((l) => { const it = items.find((x) => x.id === l.category); const t = it ? cents(it.tax_collectable) : 0; return { category: l.category, taxableCents: l.taxableCents, taxCents: t, rateBps: rateOf(t, l.taxableCents) }; });
    const total = cents(tax.amount_to_collect);
    const diff = total - lines.reduce((a, l) => a + l.taxCents, 0);
    if (diff && lines.length) lines[0].taxCents += diff;
    return { taxCents: total, lines };
  }
}

export class AvalaraProvider implements TaxProvider {
  readonly name = 'avalara' as const;
  constructor(private readonly accountId: string, private readonly licenseKey: string, private readonly companyCode: string, private readonly baseUrl: string, private readonly timeoutMs = 3000) {}
  async calculate(req: TaxRequest): Promise<TaxResult> {
    const map = codes(process.env.AVALARA_CODES, AVALARA_CODES);
    const addr = (a: TaxAddress) => ({ line1: a.line1, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country || 'US' });
    const body = {
      type: 'SalesOrder', // estimate only: nothing is committed to Avalara from a quote
      companyCode: this.companyCode,
      date: new Date().toISOString().slice(0, 10),
      customerCode: req.locationId,
      currencyCode: req.currency,
      addresses: { shipFrom: addr(req.from), shipTo: addr(req.to) },
      lines: req.lines.map((l, i) => ({ number: String(i + 1), itemCode: l.category, amount: l.taxableCents / 100, ...(map[l.category] ? { taxCode: map[l.category] } : {}) })),
    };
    const auth = Buffer.from(`${this.accountId}:${this.licenseKey}`).toString('base64');
    const json = await postJson(`${this.baseUrl}/api/v2/transactions/create`, { Authorization: `Basic ${auth}` }, body, this.timeoutMs);
    if (typeof json.totalTax !== 'number') throw new Error('Avalara response missing totalTax');
    const out = (json.lines as { lineNumber: string; tax: number }[] | undefined) || [];
    const lines = req.lines.map((l, i) => { const it = out.find((x) => x.lineNumber === String(i + 1)); const t = it ? cents(it.tax) : 0; return { category: l.category, taxableCents: l.taxableCents, taxCents: t, rateBps: rateOf(t, l.taxableCents) }; });
    const total = cents(json.totalTax);
    const diff = total - lines.reduce((a, l) => a + l.taxCents, 0);
    if (diff && lines.length) lines[0].taxCents += diff;
    return { taxCents: total, lines };
  }
}

/** Deterministic provider for tests: a flat rate (TAX_MOCK_RATE_BPS, default 800) on every taxable line except EXEMPT; TAX_MOCK_FAIL=1 throws. */
export class MockTaxProvider implements TaxProvider {
  readonly name = 'mock' as const;
  calls = 0;
  constructor(private readonly rateBps = 800, private readonly fail = false) {}
  async calculate(req: TaxRequest): Promise<TaxResult> {
    this.calls++;
    if (this.fail) throw new Error('Mock tax provider failure');
    const lines = req.lines.map((l) => { const r = l.category === 'EXEMPT' ? 0 : this.rateBps; return { category: l.category, taxableCents: l.taxableCents, rateBps: r, taxCents: Math.round((l.taxableCents * r) / 10000) }; });
    return { taxCents: lines.reduce((a, l) => a + l.taxCents, 0), lines };
  }
}

export interface TaxEngineInfo { engine: 'builtin' | 'taxjar' | 'avalara' | 'mock'; requested: string; configured: boolean; reason: string | null; cacheTtlSeconds: number; cacheEntries: number; lastError: { at: string; message: string } | null; stats: { calls: number; cacheHits: number; fallbacks: number } }

const log = new Logger('TaxEngine');

/** Picks the provider from env once, caches results by cart signature and falls back to the built-in calculation on error. */
export class TaxEngine {
  private provider: TaxProvider | null = null;
  private requested = 'builtin';
  private reason: string | null = null;
  private readonly cache = new Map<string, { at: number; result: TaxResult }>();
  private lastError: { at: string; message: string } | null = null;
  private stats = { calls: 0, cacheHits: 0, fallbacks: 0 };
  private readonly ttlMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env, provider?: TaxProvider | null) {
    this.ttlMs = Math.max(0, Number(env.TAX_CACHE_TTL_SECONDS ?? 600)) * 1000;
    if (provider !== undefined) { this.provider = provider; this.requested = provider?.name || 'builtin'; return; }
    this.requested = (env.TAX_PROVIDER || 'builtin').toLowerCase();
    const timeout = Number(env.TAX_PROVIDER_TIMEOUT_MS || 3000);
    if (this.requested === 'taxjar') {
      if (env.TAXJAR_API_KEY) this.provider = new TaxJarProvider(env.TAXJAR_API_KEY, env.TAXJAR_API_URL || (env.TAXJAR_SANDBOX === '1' ? 'https://api.sandbox.taxjar.com/v2' : 'https://api.taxjar.com/v2'), timeout);
      else this.reason = 'TAX_PROVIDER=taxjar but TAXJAR_API_KEY is not set';
    } else if (this.requested === 'avalara') {
      if (env.AVALARA_ACCOUNT_ID && env.AVALARA_LICENSE_KEY) this.provider = new AvalaraProvider(env.AVALARA_ACCOUNT_ID, env.AVALARA_LICENSE_KEY, env.AVALARA_COMPANY_CODE || 'DEFAULT', env.AVALARA_API_URL || (env.AVALARA_ENV === 'production' ? 'https://rest.avatax.com' : 'https://sandbox-rest.avatax.com'), timeout);
      else this.reason = 'TAX_PROVIDER=avalara but AVALARA_ACCOUNT_ID / AVALARA_LICENSE_KEY are not set';
    } else if (this.requested === 'mock') {
      this.provider = new MockTaxProvider(Number(env.TAX_MOCK_RATE_BPS || 800), env.TAX_MOCK_FAIL === '1');
    } else if (this.requested !== 'builtin') this.reason = `Unknown TAX_PROVIDER "${this.requested}"`;
    if (this.reason) log.warn(`${this.reason}; using the built-in rate table`);
  }

  info(): TaxEngineInfo {
    return { engine: this.provider?.name || 'builtin', requested: this.requested, configured: !!this.provider, reason: this.reason, cacheTtlSeconds: this.ttlMs / 1000, cacheEntries: this.cache.size, lastError: this.lastError, stats: { ...this.stats } };
  }

  signature(req: TaxRequest) {
    return createHash('sha256').update(JSON.stringify([req.locationId, req.currency, req.to.postalCode, req.to.region, req.to.city, req.to.line1, [...req.lines].sort((a, b) => a.category.localeCompare(b.category))])).digest('hex');
  }

  /** Built-in result in, provider result (or the built-in one plus a warning) out. */
  async resolve(req: TaxRequest, builtin: TaxResult): Promise<TaxResult & { engine: string; warning?: string }> {
    if (!this.provider || !req.lines.some((l) => l.taxableCents > 0)) return { ...builtin, engine: 'builtin' };
    const key = this.signature(req);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) { this.stats.cacheHits++; return { ...hit.result, engine: this.provider.name }; }
    this.stats.calls++;
    try {
      const result = await this.provider.calculate(req);
      if (!Number.isFinite(result.taxCents) || result.taxCents < 0) throw new Error('Provider returned an invalid tax amount');
      if (this.ttlMs) {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, { at: Date.now(), result });
      }
      return { ...result, engine: this.provider.name };
    } catch (e) {
      this.stats.fallbacks++;
      this.lastError = { at: new Date().toISOString(), message: (e as Error).message };
      log.warn(`${this.provider.name} tax calculation failed, using the built-in rate table: ${(e as Error).message}`);
      return { ...builtin, engine: 'builtin', warning: 'Tax was estimated with standard rates' };
    }
  }

  clearCache() { this.cache.clear(); }
}

let engine: TaxEngine | null = null;
/** Process-wide engine (env read on first use). */
export const taxEngine = () => (engine ??= new TaxEngine());
/** Tests: swap the engine (e.g. `new TaxEngine({}, new MockTaxProvider())`). */
export const setTaxEngine = (e: TaxEngine | null) => { engine = e; };
