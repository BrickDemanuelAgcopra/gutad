import Link from 'next/link';
import { describeFee, type FeeRuleDto, type PublicPlanDto } from '@gutad/shared';

/** Server-safe currency formatter (lib/api is a client module and can't be called from server components). */
const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

/** Fee rules in plain words, skipping zero-value rules (e.g. "0% on your own site" is shown once as a perk). */
export function FeeList({ fees, className = '' }: { fees: FeeRuleDto[]; className?: string }) {
  const shown = fees.filter((f) => f.bps || f.cents || f.type === 'COMMISSION');
  if (!shown.length) return <p className={`text-sm text-ink-500 ${className}`}>No usage fees.</p>;
  return (
    <ul className={`space-y-0.5 text-sm text-ink-700 ${className}`}>
      {shown.map((f, i) => <li key={i}>• {f.bps || f.cents ? describeFee(f) : describeFee(f).replace(/^0% on (.*)$/, 'No commission on $1')}</li>)}
    </ul>
  );
}

export const planPrice = (p: Pick<PublicPlanDto, 'subscriptionCents' | 'interval' | 'perLocation'>) =>
  p.subscriptionCents ? `${money(p.subscriptionCents)}/${p.interval === 'YEAR' ? 'yr' : 'mo'}${p.perLocation ? ' per location' : ''}` : 'No subscription';

export function PlanCard({ p, cta = true }: { p: PublicPlanDto; cta?: boolean }) {
  const included = p.features.filter((f) => f.enabled && f.kind === 'BOOLEAN');
  return (
    <div className={`flex flex-col rounded-2xl border bg-white p-5 shadow-card ${p.highlight ? 'border-brand-300 ring-1 ring-brand-200' : 'border-ink-100'}`}>
      <div className="flex items-start justify-between gap-2"><h3 className="text-lg font-bold">{p.name}</h3>{p.highlight && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">Popular</span>}</div>
      {p.tagline && <p className="text-sm text-ink-500">{p.tagline}</p>}
      <div className="mt-3 text-2xl font-extrabold">{p.subscriptionCents ? money(p.subscriptionCents) : '$0'}<span className="text-sm font-medium text-ink-500">{p.subscriptionCents ? `/${p.interval === 'YEAR' ? 'year' : 'month'}${p.perLocation ? ' per location' : ''}` : ' per month'}</span></div>
      {p.trialDays > 0 && <p className="text-xs font-medium text-emerald-700">{p.trialDays}-day free trial</p>}
      {p.setupFeeCents > 0 && <p className="text-xs text-ink-500">{money(p.setupFeeCents)} one-time setup</p>}
      <FeeList fees={p.fees} className="mt-3" />
      <ul className="mt-3 space-y-0.5 text-sm">{included.slice(0, 8).map((f) => <li key={f.key} className="text-ink-700">✓ {f.name}</li>)}</ul>
      {cta && <Link href={`/for-restaurants?plan=${p.code}`} className="mt-auto pt-4"><span className={`block rounded-xl px-4 py-2 text-center text-sm font-semibold ${p.highlight ? 'bg-brand-500 text-white hover:bg-brand-600' : 'bg-ink-100 text-ink-900 hover:bg-ink-50'}`}>Get started</span></Link>}
    </div>
  );
}
