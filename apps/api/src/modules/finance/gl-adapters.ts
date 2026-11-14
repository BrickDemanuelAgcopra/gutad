/**
 * 20.1-L general-ledger push adapters. CSV export stays the default; an adapter is used only once a connection with
 * credentials exists. The mock adapter keeps journals in memory (idempotent by reference) so tests never hit a network.
 */
export interface GlJournalLine { accountCode: string; accountName: string; debitCents: number; creditCents: number; description: string }
export interface GlJournal { reference: string; period: string; date: string; legalEntity: string; currency: string; narration: string; lines: GlJournalLine[] }
export interface GlCredentials { accessToken?: string; refreshToken?: string; clientId?: string; clientSecret?: string; [k: string]: unknown }
export interface GlContext { credentials: GlCredentials; tenantId: string | null; config: Record<string, unknown> }
export interface GlAdapter {
  readonly provider: 'MOCK' | 'QBO' | 'XERO';
  /** credentials/fields the connection needs before a push is attempted */
  validate(ctx: GlContext): string | null;
  push(journal: GlJournal, ctx: GlContext): Promise<{ externalId: string }>;
}

async function send(url: string, init: { method: string; headers: Record<string, string>; body: unknown }, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: init.method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers }, body: JSON.stringify(init.body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(t);
  }
}

/** In-memory ledger for tests and demos. `config.mockFail: true` makes pushes fail (to exercise retry). */
export class MockGlAdapter implements GlAdapter {
  readonly provider = 'MOCK' as const;
  static readonly journals = new Map<string, { externalId: string; journal: GlJournal }>();
  validate() { return null; }
  async push(journal: GlJournal, ctx: GlContext) {
    if (ctx.config.mockFail === true) throw new Error('Mock ledger rejected the journal (mockFail)');
    const hit = MockGlAdapter.journals.get(journal.reference);
    if (hit) return { externalId: hit.externalId };
    const externalId = `MJ-${journal.period}-${MockGlAdapter.journals.size + 1}`;
    MockGlAdapter.journals.set(journal.reference, { externalId, journal });
    return { externalId };
  }
}

/** QuickBooks Online JournalEntry; `requestid` makes the create idempotent on Intuit's side. */
export class QboGlAdapter implements GlAdapter {
  readonly provider = 'QBO' as const;
  validate(ctx: GlContext) { return !ctx.tenantId ? 'QuickBooks realm (company) id is required' : !ctx.credentials.accessToken ? 'QuickBooks access token is required' : null; }
  async push(journal: GlJournal, ctx: GlContext) {
    const base = (ctx.config.baseUrl as string) || process.env.QBO_API_URL || 'https://quickbooks.api.intuit.com';
    const body = {
      DocNumber: journal.reference.slice(0, 21),
      TxnDate: journal.date,
      PrivateNote: journal.narration,
      Line: journal.lines.map((l) => ({ DetailType: 'JournalEntryLineDetail', Amount: (l.debitCents || l.creditCents) / 100, Description: l.description, JournalEntryLineDetail: { PostingType: l.debitCents ? 'Debit' : 'Credit', AccountRef: { value: l.accountCode, name: l.accountName } } })),
    };
    const json = await send(`${base}/v3/company/${encodeURIComponent(ctx.tenantId!)}/journalentry?minorversion=65&requestid=${encodeURIComponent(journal.reference)}`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, body });
    const id = (json.JournalEntry as { Id?: string } | undefined)?.Id;
    if (!id) throw new Error('QuickBooks response has no JournalEntry.Id');
    return { externalId: id };
  }
}

/** Xero ManualJournal (positive = debit, negative = credit); the Idempotency-Key header dedupes retries. */
export class XeroGlAdapter implements GlAdapter {
  readonly provider = 'XERO' as const;
  validate(ctx: GlContext) { return !ctx.tenantId ? 'Xero tenant id is required' : !ctx.credentials.accessToken ? 'Xero access token is required' : null; }
  async push(journal: GlJournal, ctx: GlContext) {
    const base = (ctx.config.baseUrl as string) || process.env.XERO_API_URL || 'https://api.xero.com';
    const body = { ManualJournals: [{ Narration: journal.narration, Date: journal.date, Status: 'POSTED', LineAmountTypes: 'NoTax', JournalLines: journal.lines.map((l) => ({ LineAmount: (l.debitCents - l.creditCents) / 100, AccountCode: l.accountCode, Description: l.description })) }] };
    const json = await send(`${base}/api.xro/2.0/ManualJournals`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.credentials.accessToken}`, 'Xero-tenant-id': ctx.tenantId!, 'Idempotency-Key': journal.reference }, body });
    const id = (json.ManualJournals as { ManualJournalID?: string }[] | undefined)?.[0]?.ManualJournalID;
    if (!id) throw new Error('Xero response has no ManualJournalID');
    return { externalId: id };
  }
}

const adapters: Record<string, GlAdapter> = { MOCK: new MockGlAdapter(), QBO: new QboGlAdapter(), XERO: new XeroGlAdapter() };
export const glAdapter = (provider: string) => adapters[provider] ?? null;
/** Tests: replace an adapter (e.g. a QBO stub). */
export const setGlAdapter = (provider: string, a: GlAdapter) => { adapters[provider] = a; };
