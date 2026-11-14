'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AccessPolicy } from '@gutad/shared';
import { api } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Spinner } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { Notice, personLabel, SUPERADMIN, useStaff, useStepUp } from './common';

type NumKey = Exclude<keyof AccessPolicy, 'superadminGranters' | 'requireSecondApprover'>;
const NUMBERS: { key: NumKey; label: string; hint: string; min: number; max: number }[] = [
  { key: 'maxLoginAttempts', label: 'Failed sign-ins before lock', hint: 'per account', min: 3, max: 50 },
  { key: 'lockMinutes', label: 'Lock duration (minutes)', hint: 'after too many failures', min: 1, max: 1440 },
  { key: 'ipMaxAttempts', label: 'Failed sign-ins per IP', hint: 'any account, before the IP is throttled', min: 10, max: 10000 },
  { key: 'inactiveDays', label: 'Flag inactive after (days)', hint: 'no sign-in for this long', min: 7, max: 365 },
  { key: 'autoSuspendInactiveDays', label: 'Auto-suspend inactive after (days)', hint: '0 = never', min: 0, max: 730 },
  { key: 'reviewIntervalDays', label: 'Access review every (days)', hint: '0 = manual only', min: 0, max: 365 },
  { key: 'apiKeyMaxDays', label: 'Longest API key lifetime (days)', hint: '', min: 1, max: 3650 },
  { key: 'inviteDays', label: 'Invitation link lifetime (days)', hint: '', min: 1, max: 30 },
];

export function PolicyTab() {
  const { can, user } = useSession();
  const superadmin = !!user && (user.roles.includes(SUPERADMIN) || !!user.accessRoles?.some((r) => r.key === SUPERADMIN));
  const editable = can('security.manage') && can('settings.manage');
  const { data, reload } = useApi<{ policy: AccessPolicy; superadmins: string[] }>('/admin/iam/policy');
  const { data: staff } = useStaff();
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [draft, setDraft] = useState<AccessPolicy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const p = draft || data.policy;
  const set = (patch: Partial<AccessPolicy>) => setDraft({ ...p, ...patch });
  const changed = (Object.keys(p) as (keyof AccessPolicy)[]).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(data.policy[k]));
  const invalid = NUMBERS.some((n) => !Number.isInteger(p[n.key]) || p[n.key] < n.min || p[n.key] > n.max);
  const save = () => {
    const reason = askReason('changing the access policy');
    if (!reason) return;
    const patch = Object.fromEntries(changed.map((k) => [k, p[k]]));
    void run(async () => { await withStepUp((stepUp) => api.patch('/admin/iam/policy', { ...patch, reason, stepUp })); setDraft(null); setNotice('Access policy saved.'); await reload(); });
  };
  const emailOf = (id: string) => { const s = staff?.find((x) => x.id === id); return s ? personLabel(s) : id.slice(0, 8); };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Notice text={notice} onClose={() => setNotice(null)} />
      <Alert tone="info">Single sign-on, roles that require two-factor authentication and session timeouts live under <Link className="underline" href="/admin/security">Emergency access &amp; sign-in policy</Link>.</Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Superadmin safeguards">
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!editable || !superadmin} checked={p.requireSecondApprover} onChange={(e) => set({ requireSecondApprover: e.target.checked })} /> Superadmin grants and privileged role changes need a second superadmin</label>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-500">Who may grant superadmin (none ticked = any active superadmin)</div>
              <div className="space-y-1">{data.superadmins.map((id) => <label key={id} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!editable || !superadmin} checked={p.superadminGranters.includes(id)} onChange={(e) => set({ superadminGranters: e.target.checked ? [...p.superadminGranters, id] : p.superadminGranters.filter((x) => x !== id) })} />{emailOf(id)}</label>)}</div>
            </div>
            {!superadmin && <p className="text-xs text-ink-500">Only a superadmin can change these.</p>}
          </div>
        </Card>
        <Card title="Sign-in protection, inactivity and lifetimes">
          <div className="grid gap-2 sm:grid-cols-2">
            {NUMBERS.map((n) => <div key={n.key}><Input label={n.label} type="number" min={n.min} max={n.max} disabled={!editable} value={Number.isNaN(p[n.key]) ? '' : p[n.key]} onChange={(e) => set({ [n.key]: e.target.value === '' ? NaN : Number(e.target.value) } as Partial<AccessPolicy>)} /><span className="text-[11px] text-ink-500">{n.min}–{n.max}{n.hint ? ` · ${n.hint}` : ''}</span></div>)}
          </div>
        </Card>
      </div>
      {editable && <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!changed.length} onClick={() => setDraft(null)}>Discard</Button><Button disabled={busy || !changed.length || invalid} onClick={save}>Save {changed.length || ''} change{changed.length === 1 ? '' : 's'}</Button></div>}
    </div>
  );
}
