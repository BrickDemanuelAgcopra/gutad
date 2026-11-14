'use client';
import { Fragment, useState } from 'react';
import { APPROVAL_LIMIT_KINDS, IAM_ACTION_LABELS, IAM_ACTIONS, IAM_RESOURCES, type AccessExplanation, type ApprovalLimitKind } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Select, Spinner } from '@/components/ui';
import { FieldLabel } from './common';

interface Effective {
  user: { id: string; email: string; name: string | null; status: string; mfaEnabled: boolean };
  roles: { id: string; key: string; name: string; kind: string; primary: boolean; endsAt: string | null; source: string }[];
  superadmin: boolean;
  mfaRequired: boolean;
  notes: string[];
  matrix: { resource: string; label: string; group: string; actions: { action: string; permission: string; granted: boolean; via: string[]; reasons: string[] }[] }[];
  fields: { field: string; label: string; view: boolean; export: boolean }[];
  approvalLimits: 'unlimited' | Record<string, number>;
  modules: { key: string; label: string; group: string }[];
}

const GROUPS = ['Modules', 'Sensitive data'] as const;

export function EffectiveAccess({ userId }: { userId: string }) {
  const { data: e, error } = useApi<Effective>(`/admin/iam/users/${userId}/effective`);
  if (error) return <Alert>{error}</Alert>;
  if (!e) return <Spinner />;
  const limits = e.approvalLimits;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{e.superadmin && <Badge tone="bad">superadmin</Badge>}{e.mfaRequired && <Badge tone="info">MFA required by a role</Badge>}{e.roles.map((r) => <Badge key={`${r.id}-${r.source}`} tone={r.source === 'emergency' ? 'bad' : 'neutral'}>{r.name}{r.source === 'emergency' ? ' (emergency)' : ''}</Badge>)}</div>
      {e.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-700">{e.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <div className="overflow-x-auto rounded-xl border border-ink-100">
        <table className="w-full text-xs">
          <thead className="bg-ink-50 text-ink-500"><tr><th className="sticky left-0 bg-ink-50 px-2 py-1.5 text-left font-medium">Resource</th>{IAM_ACTIONS.map((a) => <th key={a} className="px-2 py-1.5 font-medium">{IAM_ACTION_LABELS[a]}</th>)}</tr></thead>
          <tbody className="divide-y divide-ink-100">
            {GROUPS.map((g) => (
              <Fragment key={g}>
                <tr><td colSpan={IAM_ACTIONS.length + 1} className="bg-ink-50/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{g}</td></tr>
                {e.matrix.filter((m) => m.group === g).map((m) => (
                  <tr key={m.resource}>
                    <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-1 font-medium">{m.label}</td>
                    {IAM_ACTIONS.map((a) => {
                      const c = m.actions.find((x) => x.action === a);
                      if (!c) return <td key={a} />;
                      return <td key={a} className="px-1 py-1 text-center"><span title={c.granted ? `Granted via ${c.via.join(', ') || '—'}` : c.reasons.join('; ')} className={`inline-flex h-6 w-6 cursor-help items-center justify-center rounded ${c.granted ? 'bg-emerald-100 text-emerald-800' : c.via.length ? 'bg-amber-100 text-amber-800' : 'bg-ink-50 text-ink-300'}`}>{c.granted ? '✓' : '✕'}</span></td>;
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">Hover a cell for where access comes from or why it is denied. Amber cells are held through a role but blocked (status, MFA or data ceiling).</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <FieldLabel>Sensitive fields</FieldLabel>
          <ul className="space-y-1 text-xs">{e.fields.map((f) => <li key={f.field}>{f.label}: <Badge tone={f.view ? 'good' : 'neutral'}>{f.view ? 'view' : 'hidden'}</Badge> {f.export && <Badge tone="good">export</Badge>}</li>)}</ul>
        </div>
        <div>
          <FieldLabel>Approval limits</FieldLabel>
          {limits === 'unlimited' ? <p className="text-xs">Unlimited (superadmin).</p> : (
            <ul className="space-y-1 text-xs">{(Object.keys(APPROVAL_LIMIT_KINDS) as ApprovalLimitKind[]).map((k) => <li key={k}>{APPROVAL_LIMIT_KINDS[k]}: <b>{limits[k] !== undefined ? money(limits[k]) : 'no cap'}</b></li>)}</ul>
          )}
        </div>
        <div>
          <FieldLabel>Console modules visible</FieldLabel>
          {e.modules.length ? <div className="flex flex-wrap gap-1">{e.modules.map((m) => <Badge key={m.key}>{m.label}</Badge>)}</div> : <p className="text-xs text-ink-500">None.</p>}
        </div>
      </div>
      <Explain userId={userId} />
    </div>
  );
}

function Explain({ userId }: { userId: string }) {
  const [perm, setPerm] = useState('');
  const [orgQ, setOrgQ] = useState('');
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [res, setRes] = useState<AccessExplanation | null>(null);
  const { run, error, busy } = useAction();
  const { data: hits } = useApi<{ id: string; name: string }[]>(orgQ.length >= 2 ? `/admin/organizations/lookup?q=${encodeURIComponent(orgQ)}` : null, { deps: [orgQ] });
  const ask = () => run(async () => setRes(await api.get<AccessExplanation>(`/admin/iam/explain?${new URLSearchParams({ userId, permission: perm, ...(org ? { organizationId: org.id } : {}) })}`)));
  return (
    <div className="space-y-2 rounded-xl border border-ink-100 p-3">
      <FieldLabel>Explain one permission</FieldLabel>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Select label="Permission" value={perm} onChange={(e) => { setPerm(e.target.value); setRes(null); }}>
          <option value="">Choose…</option>
          {IAM_RESOURCES.map((r) => <optgroup key={r.key} label={r.label}>{r.actions.map((a) => <option key={a} value={`${r.key}:${a}`}>{r.label}: {IAM_ACTION_LABELS[a]}</option>)}</optgroup>)}
        </Select>
        <div>
          {org ? <div className="text-xs"><span className="mb-1 block font-medium text-ink-500">Organization</span><span className="rounded-full bg-ink-100 px-2 py-1">{org.name} <button onClick={() => { setOrg(null); setRes(null); }}>×</button></span></div> : <Input label="In organization (optional, search)" value={orgQ} onChange={(e) => setOrgQ(e.target.value)} />}
          {!org && hits && orgQ && <div className="mt-1 flex flex-wrap gap-1">{hits.map((o) => <button key={o.id} className="rounded-full border border-ink-100 px-2 py-0.5 text-xs hover:bg-ink-50" onClick={() => { setOrg(o); setOrgQ(''); setRes(null); }}>{o.name}</button>)}</div>}
        </div>
        <Button size="sm" disabled={!perm || busy} onClick={ask}>Explain</Button>
      </div>
      {res && (
        <div className={`rounded-lg border p-2 text-xs ${res.allowed ? 'border-emerald-100 bg-emerald-50 text-emerald-900' : 'border-red-100 bg-red-50 text-red-900'}`}>
          <div className="font-semibold">{res.allowed ? 'Allowed' : 'Denied'}: {res.permission}</div>
          <ul className="mt-1 list-disc pl-4">{res.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
