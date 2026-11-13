import Link from 'next/link';
import { PRODUCT_LINES, type PublicPlanDto } from '@gutad/shared';
import { serverGet } from '@/lib/server';
import { PlanCard } from '@/components/plan-ui';
import { PricingTabs } from './tabs';

export const revalidate = 60;
export const metadata = { title: 'Pricing for restaurants', description: 'Gutad plans for ordering, reservations and the full suite.' };

export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const plans = (await serverGet<PublicPlanDto[]>('/public/plans')) || [];
  const lines = PRODUCT_LINES.filter((l) => plans.some((p) => p.productLine === l.key));
  const active = lines.find((l) => l.key === sp.line)?.key || lines[0]?.key;
  const shown = plans.filter((p) => p.productLine === active);
  const featureKeys = [...new Set(shown.flatMap((p) => p.features.filter((f) => f.enabled || f.limitValue != null).map((f) => f.key)))];
  const featureMeta = shown[0]?.features.filter((f) => featureKeys.includes(f.key)) || [];
  return (
    <div>
      <h1 className="text-3xl font-bold">Pricing for restaurants</h1>
      <p className="mt-2 max-w-2xl text-ink-700">Pick the product you need. Orders on your own link and website are commission-free on every plan; you pay commission only when Gutad brings you the customer.</p>
      {lines.length > 0 ? (
        <>
          <div className="mt-6"><PricingTabs lines={lines.map((l) => ({ key: l.key, label: l.label }))} active={active!} /></div>
          <p className="mt-3 text-sm text-ink-500">{lines.find((l) => l.key === active)?.blurb}</p>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{shown.map((p) => <PlanCard key={p.code} p={p} />)}</div>
          {shown.length > 0 && featureMeta.length > 0 && (
            <div className="mt-10 overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-card">
              <table className="w-full min-w-[520px] text-sm">
                <thead><tr className="border-b border-ink-100 text-left"><th className="p-3">Compare</th>{shown.map((p) => <th key={p.code} className="p-3">{p.name}</th>)}</tr></thead>
                <tbody>
                  {featureMeta.map((f) => (
                    <tr key={f.key} className="border-b border-ink-50 last:border-0">
                      <td className="p-3 text-ink-700">{f.name}</td>
                      {shown.map((p) => {
                        const x = p.features.find((y) => y.key === f.key);
                        return <td key={p.code} className="p-3">{f.kind === 'LIMIT' ? (x?.limitValue ?? (x?.enabled ? 'Unlimited' : '—')) : x?.enabled ? <span className="text-emerald-700">✓</span> : <span className="text-ink-300">—</span>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="mt-6 text-ink-500">Plans are being updated. <Link className="underline" href="/for-restaurants">Contact us to get started</Link>.</p>
      )}
      <p className="mt-6 text-xs text-ink-500">Card processing applies to orders paid through Gutad. Your Order Form sets the final terms. See the <Link className="underline" href="/merchant-agreement">Merchant Agreement</Link>.</p>
    </div>
  );
}
