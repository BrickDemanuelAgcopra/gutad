'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

export default function GrowthPage() {
  const { org, loc } = useMerchant();
  const { data: camps, reload } = useApi<{ id: string; name: string; kind: string; status: string; budgetCents: number; spentCents: number; sentCount: number; conversions: number; attributedRevenueCents: number; funder: string; endsAt: string | null }[]>(org ? `/organizations/${org.id}/campaigns` : null, { deps: [org?.id] });
  const { data: segs } = useApi<{ id: string; name: string }[]>(org ? `/organizations/${org.id}/segments` : null, { deps: [org?.id] });
  const { run, error } = useAction();
  const [c, setC] = useState({ name: '', kind: 'EMAIL', budget: '', segmentId: '', subject: '', body: '', bid: '', keyword: '' });
  const [coupon, setCoupon] = useState({ code: '', kind: 'PERCENT', value: '', min: '', maxUses: '' });
  const [made, setMade] = useState<string | null>(null);
  if (!org) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Growth</h1>
      {error && <Alert>{error}</Alert>}
      <Table rows={camps || []} cols={[{ key: 'n', label: 'Campaign', render: (r) => <span>{r.name} <span className="text-xs text-ink-500">{r.kind} · {r.funder}</span></span> }, { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> }, { key: 'b', label: 'Budget / spent', render: (r) => `${money(r.budgetCents)} / ${money(r.spentCents)}` }, { key: 'o', label: 'Sent / conversions', render: (r) => `${r.sentCount} / ${r.conversions}` }, { key: 'rev', label: 'Attributed revenue', render: (r) => money(r.attributedRevenueCents) }, { key: 'a', label: '', render: (r) => ['EMAIL', 'SMS'].includes(r.kind) && r.status === 'ACTIVE' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { const res = await api.post<{ queued: number }>(`/campaigns/${r.id}/send`, {}); alert(`Queued ${res.queued} consented messages`); reload(); })}>Send</Button> : null }]} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="New campaign">
          <div className="space-y-2">
            <Input label="Name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
            <Select label="Kind" value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="SPONSORED">Sponsored placement</option><option value="COUPON">Coupon campaign</option></Select>
            {['EMAIL', 'SMS'].includes(c.kind) && (<><Select label="Segment" value={c.segmentId} onChange={(e) => setC({ ...c, segmentId: e.target.value })}><option value="">All consented guests</option>{segs?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Input label="Subject" value={c.subject} onChange={(e) => setC({ ...c, subject: e.target.value })} /><Textarea label="Message" value={c.body} onChange={(e) => setC({ ...c, body: e.target.value })} /></>)}
            {c.kind === 'SPONSORED' && (<><Input label="Bid per click (USD)" value={c.bid} onChange={(e) => setC({ ...c, bid: e.target.value })} /><Input label="Keyword (optional)" value={c.keyword} onChange={(e) => setC({ ...c, keyword: e.target.value })} /></>)}
            <Input label="Budget (USD, stops when exhausted)" value={c.budget} onChange={(e) => setC({ ...c, budget: e.target.value })} />
            <Button disabled={!c.name} onClick={() => run(async () => { await api.post(`/organizations/${org.id}/campaigns`, { name: c.name, kind: c.kind, budgetCents: Math.round(Number(c.budget || 0) * 100), segmentId: c.segmentId || undefined, content: { subject: c.subject, body: c.body }, endsAt: new Date(Date.now() + 30 * 86400000).toISOString(), sponsored: c.kind === 'SPONSORED' && loc ? { locationId: loc.id, bidCents: Math.round(Number(c.bid || 0.5) * 100), keyword: c.keyword || undefined } : undefined }); setC({ ...c, name: '' }); reload(); })}>Create</Button>
          </div>
        </Card>
        <Card title="Coupon">
          <div className="space-y-2">
            <Input label="Code (blank = random)" value={coupon.code} onChange={(e) => setCoupon({ ...coupon, code: e.target.value.toUpperCase() })} />
            <Select label="Type" value={coupon.kind} onChange={(e) => setCoupon({ ...coupon, kind: e.target.value })}><option value="PERCENT">Percent off</option><option value="FIXED">Fixed amount</option><option value="FREE_DELIVERY">Free delivery</option></Select>
            <Input label={coupon.kind === 'PERCENT' ? 'Percent' : 'Amount (USD)'} value={coupon.value} onChange={(e) => setCoupon({ ...coupon, value: e.target.value })} />
            <Input label="Minimum subtotal (USD)" value={coupon.min} onChange={(e) => setCoupon({ ...coupon, min: e.target.value })} />
            <Input label="Max uses" value={coupon.maxUses} onChange={(e) => setCoupon({ ...coupon, maxUses: e.target.value })} />
            <Button variant="secondary" onClick={() => run(async () => { const r = await api.post<{ code: string }>(`/organizations/${org.id}/coupons`, { code: coupon.code || undefined, kind: coupon.kind, value: coupon.kind === 'PERCENT' ? Math.round(Number(coupon.value) * 100) : Math.round(Number(coupon.value || 0) * 100), minSubtotalCents: Math.round(Number(coupon.min || 0) * 100), maxUses: coupon.maxUses ? Number(coupon.maxUses) : undefined, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() }); setMade(r.code); })}>Create coupon</Button>
            {made && <Alert tone="good">Coupon <b>{made}</b> is live (merchant-funded). Expires {when(new Date(Date.now() + 90 * 86400000))}.</Alert>}
          </div>
        </Card>
      </div>
    </div>
  );
}
