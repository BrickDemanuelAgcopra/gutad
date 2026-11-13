'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { money } from '@/lib/api';
import { useApi } from '@/lib/hooks';

export interface Filter { range: string; regionId: string; organizationId: string; locationId: string; brandId: string; channel: string }
export const EMPTY_FILTER: Filter = { range: '30d', regionId: '', organizationId: '', locationId: '', brandId: '', channel: '' };
interface Options { regions: { id: string; name: string }[]; organizations: { id: string; name: string }[]; locations: { id: string; name: string; organizationId: string; regionId: string | null }[]; brands: { id: string; name: string }[]; channels: string[] }

const DAYS: Record<string, number> = { today: 0, '7d': 7, '30d': 30, '90d': 90 };

/** Filter → query string shared by every dashboard call and every drill-down link. */
export function filterQuery(f: Filter): string {
  const p = new URLSearchParams();
  const now = new Date();
  const from = f.range === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime() - (DAYS[f.range] ?? 30) * 86400_000);
  p.set('from', from.toISOString());
  for (const k of ['regionId', 'organizationId', 'locationId', 'brandId', 'channel'] as const) if (f[k]) p.set(k, f[k]);
  return p.toString();
}

export function useFilter() {
  const [f, setF] = useState<Filter>(EMPTY_FILTER);
  const q = useMemo(() => filterQuery(f), [f]);
  return { f, setF, q };
}

/** One row of filters above the charts: time range, then dimensions. */
export function FilterBar({ f, setF, range = true }: { f: Filter; setF: (f: Filter) => void; range?: boolean }) {
  const { data: o } = useApi<Options>('/admin/ops/filters');
  const sel = 'rounded-lg border border-ink-100 bg-white px-2 py-1.5 text-sm';
  const locs = (o?.locations || []).filter((l) => (!f.organizationId || l.organizationId === f.organizationId) && (!f.regionId || l.regionId === f.regionId));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {range && <div className="flex overflow-hidden rounded-lg border border-ink-100 bg-white text-sm">{['today', '7d', '30d', '90d'].map((r) => <button key={r} onClick={() => setF({ ...f, range: r })} className={`px-3 py-1.5 ${f.range === r ? 'bg-brand-500 font-medium text-white' : 'text-ink-700 hover:bg-ink-50'}`}>{r === 'today' ? 'Today' : r}</button>)}</div>}
      <select aria-label="Region" className={sel} value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value, locationId: '' })}><option value="">All regions</option>{o?.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="Merchant" className={sel} value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value, locationId: '' })}><option value="">All merchants</option>{o?.organizations.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="Location" className={sel} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">All locations</option>{locs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="Brand" className={sel} value={f.brandId} onChange={(e) => setF({ ...f, brandId: e.target.value })}><option value="">All brands</option>{o?.brands.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="Channel" className={sel} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">All channels</option>{o?.channels.map((c) => <option key={c} value={c}>{c.toLowerCase().replace('_', ' ')}</option>)}</select>
      {JSON.stringify(f) !== JSON.stringify({ ...EMPTY_FILTER, range: f.range }) && <button className="text-xs text-ink-500 underline" onClick={() => setF({ ...EMPTY_FILTER, range: f.range })}>Clear</button>}
    </div>
  );
}

/** Headline number with change vs the previous period; the whole tile links to the underlying orders. */
export function KpiTile({ label, value, prev, cur, href, hint, invert }: { label: string; value: string; cur?: number; prev?: number; href?: string; hint?: string; invert?: boolean }) {
  const delta = cur !== undefined && prev !== undefined && prev !== 0 ? (cur - prev) / Math.abs(prev) : null;
  const good = delta === null ? null : invert ? delta < 0 : delta > 0;
  const body = (
    <div className="h-full rounded-2xl border border-ink-100 bg-white p-4 shadow-card transition hover:border-brand-200">
      <div className="text-xs font-medium text-ink-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-ink-900">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-500">
        {delta !== null && <span className={good ? 'text-emerald-700' : 'text-red-700'}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}%</span>}
        {hint && <span>{hint}</span>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

/** Single-series daily bars (brand hue, no legend; the title names the series). Hover shows the exact value. */
export function TrendBars({ data, label }: { data: { day: string; value: number }[]; label: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <p className="text-sm text-ink-500">No orders in this period.</p>;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="relative flex h-40 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div key={d.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div className="w-full rounded-t-[4px] bg-brand-500" style={{ height: `${Math.max(2, (d.value / max) * 100)}%`, opacity: hover === null || hover === i ? 1 : 0.45 }} />
          </div>
        ))}
        {hover !== null && <div className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 rounded-lg border border-ink-100 bg-white px-2 py-1 text-xs shadow-card"><b>{data[hover].day}</b> · {label(data[hover].value)}</div>}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-500"><span>{data[0].day}</span><span>{data[data.length - 1].day}</span></div>
    </div>
  );
}

/** Horizontal bars with the value in text ink; each row drills down to its orders. */
export function BarList<R extends { key: string | null; label: string }>({ rows, value, fmt, href }: { rows: R[]; value: (r: R) => number; fmt: (v: number) => string; href?: (r: R) => string }) {
  if (!rows.length) return <p className="text-sm text-ink-500">No data.</p>;
  const max = Math.max(1, ...rows.map((r) => value(r)));
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 12).map((r) => {
        const v = value(r);
        const inner = (
          <div className="group" title={`${r.label}: ${fmt(v)}`}>
            <div className="flex justify-between text-xs"><span className="truncate text-ink-700 group-hover:underline">{r.label}</span><span className="tabular-nums text-ink-900">{fmt(v)}</span></div>
            <div className="mt-0.5 h-2 rounded-full bg-ink-50"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${Math.max(1, (v / max) * 100)}%` }} /></div>
          </div>
        );
        return <li key={String(r.key)}>{href ? <Link href={href(r)}>{inner}</Link> : inner}</li>;
      })}
    </ul>
  );
}

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
export { money };
