'use client';
import Link from 'next/link';
import { useState } from 'react';
import { DEFAULT_APPROVAL_THRESHOLDS } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input } from '@/components/ui';
import { askReason, pendingNotice, SectionTitle } from '@/components/admin-ui';

export default function AdminSettings() {
  const { data: s, reload } = useApi<{ env: Record<string, string>; settings: Record<string, unknown> }>('/admin/settings');
  const { run, error } = useAction();
  const [kv, setKv] = useState({ key: '', value: '' });
  const [info, setInfo] = useState<string | null>(null);
  const t = { ...DEFAULT_APPROVAL_THRESHOLDS, ...((s?.settings['approvals.thresholds'] as object) || {}) } as typeof DEFAULT_APPROVAL_THRESHOLDS;
  const [th, setTh] = useState<typeof DEFAULT_APPROVAL_THRESHOLDS | null>(null);
  const cur = th || t;
  const save = (key: string, value: unknown) => {
    const reason = askReason(`changing ${key}`);
    if (!reason) return;
    run(async () => { const r = await api.post('/admin/settings', { key, value, reason }); setInfo(pendingNotice(r) || `Saved ${key}.`); setTh(null); reload(); });
  };
  return (
    <div className="space-y-4">
      <SectionTitle title="Platform settings" hint="Fee, payout, beneficiary and approval settings need a second person's approval before they apply." />
      {error && <Alert>{error}</Alert>}
      {info && <Alert tone="info">{info} {info.startsWith('Sent') && <Link className="underline" href="/admin/approvals">View approvals</Link>}</Alert>}
      <p className="text-sm text-ink-500">Staff roles, MFA, SSO and session policy live in <Link className="underline" href="/admin/security">Staff & access</Link>. The audit trail is in <Link className="underline" href="/admin/audit">Audit history</Link>.</p>
      <Card title="Approval thresholds">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(cur.refundByRole).map(([role, cents]) => <Input key={role} label={`Refund limit: ${role.toLowerCase()} (USD)`} type="number" value={cents / 100} onChange={(e) => setTh({ ...cur, refundByRole: { ...cur.refundByRole, [role]: Math.round(Number(e.target.value) * 100) } })} />)}
          <Input label="Price change needing approval (%; 0 = off)" type="number" value={cur.priceChangeBps / 100} onChange={(e) => setTh({ ...cur, priceChangeBps: Math.round(Number(e.target.value) * 100) })} />
          <Input label="Purchase order needing approval (USD; 0 = off)" type="number" value={cur.purchaseOrderCents / 100} onChange={(e) => setTh({ ...cur, purchaseOrderCents: Math.round(Number(e.target.value) * 100) })} />
          <Input label="Payout needing a second person (USD)" type="number" value={cur.payoutCents / 100} onChange={(e) => setTh({ ...cur, payoutCents: Math.round(Number(e.target.value) * 100) })} />
        </div>
        <p className="mt-2 text-xs text-ink-500">Now: support refunds up to {money(t.refundByRole.SUPPORT || 0)}, purchase orders over {money(t.purchaseOrderCents)} need approval, price changes {t.priceChangeBps ? `over ${t.priceChangeBps / 100}%` : 'never'} need approval. Merchant staff use the approval limit on their membership; owners are unlimited.</p>
        <Button className="mt-2" size="sm" disabled={!th} onClick={() => save('approvals.thresholds', cur)}>Request change</Button>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Runtime configuration">{s && <pre className="overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(s.env, null, 2)}</pre>}</Card>
        <Card title="All settings">
          <pre className="max-h-72 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(s?.settings || {}, null, 2)}</pre>
          <div className="mt-2 grid grid-cols-2 gap-2"><Input placeholder="key" value={kv.key} onChange={(e) => setKv({ ...kv, key: e.target.value })} /><Input placeholder="JSON value" value={kv.value} onChange={(e) => setKv({ ...kv, value: e.target.value })} /></div>
          <Button className="mt-2" variant="secondary" onClick={() => { try { save(kv.key, JSON.parse(kv.value)); } catch { setInfo('Value must be valid JSON (strings in quotes).'); } }}>Save setting</Button>
        </Card>
      </div>
    </div>
  );
}
