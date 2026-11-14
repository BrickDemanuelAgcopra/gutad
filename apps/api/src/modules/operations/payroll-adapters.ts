/**
 * 23.3-P payroll provider adapters. The CSV export stays available; MOCK is the default adapter and keeps submissions
 * in memory. Real providers are used only once a connection with credentials exists.
 */
export interface PayrollLine { userId: string; providerEmployeeId: string; name: string; email: string; week: string; regularHours: number; overtimeHours: number; rateCents: number; overtimeMultiplier: number; grossCents: number }
export interface PayrollSubmission { reference: string; periodStart: string; periodEnd: string; locationName: string; lines: PayrollLine[] }
export interface PayrollContext { credentials: { accessToken?: string; [k: string]: unknown }; companyId: string | null; config: Record<string, unknown> }
export interface PayrollAdapter {
  readonly provider: 'MOCK' | 'GUSTO' | 'ADP';
  /** provider employee ids are required for real providers (config.employeeIds) */
  readonly needsEmployeeIds: boolean;
  validate(ctx: PayrollContext): string | null;
  push(sub: PayrollSubmission, ctx: PayrollContext): Promise<{ externalId: string }>;
}

async function call(url: string, method: string, headers: Record<string, string>, body?: unknown, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as unknown) : null;
  } finally {
    clearTimeout(t);
  }
}

/** In-memory payroll; `config.mockFail: true` fails the push (to exercise retry). Idempotent by reference. */
export class MockPayrollAdapter implements PayrollAdapter {
  readonly provider = 'MOCK' as const;
  readonly needsEmployeeIds = false;
  static readonly submissions = new Map<string, { externalId: string; submission: PayrollSubmission }>();
  validate() { return null; }
  async push(sub: PayrollSubmission, ctx: PayrollContext) {
    if (ctx.config.mockFail === true) throw new Error('Mock payroll rejected the hours (mockFail)');
    const hit = MockPayrollAdapter.submissions.get(sub.reference);
    if (hit) return { externalId: hit.externalId };
    const externalId = `MP-${sub.periodStart}-${MockPayrollAdapter.submissions.size + 1}`;
    MockPayrollAdapter.submissions.set(sub.reference, { externalId, submission: sub });
    return { externalId };
  }
}

/** Gusto: find the unprocessed regular payroll covering the period and fill hourly compensations (regular + overtime). */
export class GustoPayrollAdapter implements PayrollAdapter {
  readonly provider = 'GUSTO' as const;
  readonly needsEmployeeIds = true;
  validate(ctx: PayrollContext) { return !ctx.companyId ? 'Gusto company id is required' : !ctx.credentials.accessToken ? 'Gusto access token is required' : null; }
  async push(sub: PayrollSubmission, ctx: PayrollContext) {
    const base = (ctx.config.baseUrl as string) || process.env.GUSTO_API_URL || 'https://api.gusto.com';
    const h = { Authorization: `Bearer ${ctx.credentials.accessToken}`, 'X-Gusto-API-Version': '2024-04-01' };
    const list = (await call(`${base}/v1/companies/${encodeURIComponent(ctx.companyId!)}/payrolls?processing_statuses=unprocessed&start_date=${sub.periodStart}&end_date=${sub.periodEnd}`, 'GET', h)) as { uuid?: string; payroll_uuid?: string; version?: string }[] | null;
    const p = list?.[0];
    const id = p?.uuid || p?.payroll_uuid;
    if (!id) throw new Error(`No unprocessed Gusto payroll covers ${sub.periodStart}…${sub.periodEnd}`);
    const by = new Map<string, { regular: number; overtime: number }>();
    for (const l of sub.lines) { const c = by.get(l.providerEmployeeId) || { regular: 0, overtime: 0 }; c.regular += l.regularHours; c.overtime += l.overtimeHours; by.set(l.providerEmployeeId, c); }
    await call(`${base}/v1/companies/${encodeURIComponent(ctx.companyId!)}/payrolls/${id}`, 'PUT', h, { version: p?.version, employee_compensations: [...by.entries()].map(([employee_uuid, c]) => ({ employee_uuid, hourly_compensations: [{ name: 'Regular Hours', hours: c.regular.toFixed(3) }, { name: 'Overtime', hours: c.overtime.toFixed(3) }] })) });
    return { externalId: id };
  }
}

/** ADP Workforce Now pay data input: one batch per period with regular and overtime hours per associate. */
export class AdpPayrollAdapter implements PayrollAdapter {
  readonly provider = 'ADP' as const;
  readonly needsEmployeeIds = true;
  validate(ctx: PayrollContext) { return !ctx.companyId ? 'ADP company code is required' : !ctx.credentials.accessToken ? 'ADP access token is required' : null; }
  async push(sub: PayrollSubmission, ctx: PayrollContext) {
    const base = (ctx.config.baseUrl as string) || process.env.ADP_API_URL || 'https://api.adp.com';
    const body = { events: [{ data: { transform: { payDataInput: { payrollGroupCode: { codeValue: ctx.companyId }, payrollRegionCode: { codeValue: (ctx.config.payrollRegion as string) || undefined }, externalBatchID: sub.reference, payeePayInputs: sub.lines.map((l) => ({ associateOID: l.providerEmployeeId, payInputs: [{ earningInputs: [{ earningCode: { codeValue: 'REG' }, numberOfHours: l.regularHours }, ...(l.overtimeHours ? [{ earningCode: { codeValue: 'OT' }, numberOfHours: l.overtimeHours }] : [])] }] })) } } } }] };
    const json = (await call(`${base}/events/payroll/v1/pay-data-input.add`, 'POST', { Authorization: `Bearer ${ctx.credentials.accessToken}` }, body)) as { events?: { eventID?: string }[] } | null;
    const id = json?.events?.[0]?.eventID;
    if (!id) throw new Error('ADP response has no eventID');
    return { externalId: id };
  }
}

const adapters: Record<string, PayrollAdapter> = { MOCK: new MockPayrollAdapter(), GUSTO: new GustoPayrollAdapter(), ADP: new AdpPayrollAdapter() };
export const payrollAdapter = (p: string) => adapters[p] ?? null;
export const setPayrollAdapter = (p: string, a: PayrollAdapter) => { adapters[p] = a; };
