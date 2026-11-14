'use client';
import { useState } from 'react';
import { IAM_ACTION_LABELS, IAM_RESOURCES } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, Input, Modal, Textarea } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { day, Notice, SecretModal } from './common';

interface ApiKey { id: string; name: string; prefix: string; expiresAt: string; lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; rotatedFromId: string | null; createdAt: string; state: 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' }
interface ServiceAccount { id: string; name: string; description: string; ownerId: string | null; ownerEmail: string | null; status: string; permissions: string[]; organizationIds: string[]; ipAllowlist: string[]; createdAt: string; keys: ApiKey[] }

const KEY_TONE = { ACTIVE: 'good', EXPIRING: 'warn', EXPIRED: 'neutral', REVOKED: 'bad' } as const;
const GRANTABLE = IAM_RESOURCES.filter((r) => r.key !== 'security');

export function ServiceAccountsTab() {
  const { can } = useSession();
  const manage = can('integrations.manage');
  const { data, reload } = useApi<ServiceAccount[]>('/admin/iam/service-accounts');
  const { run, error, busy } = useAction();
  const [form, setForm] = useState<ServiceAccount | 'new' | null>(null);
  const [keyFor, setKeyFor] = useState<ServiceAccount | null>(null);
  const [secret, setSecret] = useState<{ key: string; note: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const setStatus = (s: ServiceAccount) => {
    const status = s.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const reason = askReason(`${status === 'ACTIVE' ? 'enabling' : 'disabling'} ${s.name}`);
    if (reason) void run(async () => { await api.patch(`/admin/iam/service-accounts/${s.id}`, { status, reason }); setNotice(`${s.name} ${status === 'ACTIVE' ? 'enabled' : 'disabled'}.`); await reload(); });
  };
  const rotate = (k: ApiKey) => {
    const g = window.prompt(`Rotate "${k.name}". Hours the old key keeps working (0–168):`, '24');
    if (g === null) return;
    const graceHours = Math.max(0, Math.min(168, Math.round(Number(g) || 0)));
    void run(async () => {
      const r = await api.post<{ key: string; previousKeyExpiresAt: string }>(`/admin/iam/keys/${k.id}/rotate`, { graceHours });
      setSecret({ key: r.key, note: `The previous key (${k.prefix}…) keeps working until ${when(r.previousKeyExpiresAt)}.` });
      await reload();
    });
  };
  const revoke = (k: ApiKey) => {
    const reason = askReason(`revoking the key ${k.prefix}…`);
    if (reason) void run(async () => { await api.delete(`/admin/iam/keys/${k.id}?reason=${encodeURIComponent(reason)}`); setNotice(`Key ${k.prefix}… revoked.`); await reload(); });
  };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Notice text={notice} onClose={() => setNotice(null)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">Integrations sign in with API keys of a service account. Keys are shown once, expire, and can be rotated with a grace period. Service accounts can never manage users, roles or security.</p>
        {manage && <Button onClick={() => setForm('new')}>New service account</Button>}
      </div>
      {!data?.length ? <Empty>No service accounts yet.</Empty> : data.map((s) => (
        <Card key={s.id} title={<span className="flex flex-wrap items-center gap-2">{s.name}<Badge tone={s.status === 'ACTIVE' ? 'good' : 'bad'}>{s.status}</Badge></span>} action={manage ? <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setForm(s)}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setStatus(s)}>{s.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>{s.status === 'ACTIVE' && <Button size="sm" variant="secondary" onClick={() => setKeyFor(s)}>New key</Button>}</div> : undefined}>
          <div className="space-y-2 text-sm">
            {s.description && <p className="text-ink-700">{s.description}</p>}
            <p className="text-xs text-ink-500">Owner {s.ownerEmail || '—'} · {s.organizationIds.length ? `${s.organizationIds.length} organization(s)` : 'all organizations'} · {s.permissions.length} permission(s)</p>
            <div className="flex flex-wrap gap-1">{s.permissions.map((p) => <span key={p} className="rounded bg-ink-50 px-1.5 py-0.5 text-[11px] text-ink-700">{p}</span>)}</div>
            {s.keys.length > 0 && (
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
                {s.keys.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span><code className="rounded bg-ink-50 px-1">{k.prefix}…</code> {k.name} <Badge tone={KEY_TONE[k.state]}>{k.state}</Badge><span className="block text-ink-500">expires {day(k.expiresAt)} · last used {k.lastUsedAt ? `${when(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'never'}</span></span>
                    {manage && !k.revokedAt && k.state !== 'EXPIRED' && <span className="flex gap-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => rotate(k)}>Rotate</Button><Button size="sm" variant="ghost" className="text-red-600" disabled={busy} onClick={() => revoke(k)}>Revoke</Button></span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ))}
      {form && <AccountForm account={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={async (t) => { setForm(null); setNotice(t); await reload(); }} />}
      {keyFor && <KeyForm account={keyFor} onClose={() => setKeyFor(null)} onCreated={async (key) => { setKeyFor(null); setSecret({ key, note: '' }); await reload(); }} />}
      <SecretModal title="API key" secret={secret?.key || null} note={<>Copy this key now: you won&apos;t see it again. Store it in your integration&apos;s secret manager. {secret?.note}</>} onClose={() => setSecret(null)} />
    </div>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: ServiceAccount | null; onClose: () => void; onSaved: (t: string) => Promise<void> }) {
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ name: account?.name || '', description: account?.description || '', permissions: account?.permissions || [], organizationIds: account?.organizationIds || [] });
  const [orgQ, setOrgQ] = useState('');
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const { data: hits } = useApi<{ id: string; name: string }[]>(orgQ.length >= 2 ? `/admin/organizations/lookup?q=${encodeURIComponent(orgQ)}` : null, { deps: [orgQ] });
  const toggle = (p: string, on: boolean) => setF({ ...f, permissions: on ? Array.from(new Set([...f.permissions, p])) : f.permissions.filter((x) => x !== p) });
  const save = () => {
    const reason = askReason(account ? `changing ${account.name}` : `creating the ${f.name} service account`);
    if (!reason) return;
    void run(async () => {
      if (account) await api.patch(`/admin/iam/service-accounts/${account.id}`, { description: f.description, permissions: f.permissions, organizationIds: f.organizationIds, reason });
      else await api.post('/admin/iam/service-accounts', { name: f.name.trim(), description: f.description, permissions: f.permissions, organizationIds: f.organizationIds, reason });
      await onSaved(account ? `${account.name} saved.` : `${f.name.trim()} created. Create a key to start using it.`);
    });
  };
  return (
    <Modal open onClose={onClose} title={account ? `Edit ${account.name}` : 'New service account'}>
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        {!account && <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        <Textarea label="Description" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-500">Permissions (you can only grant what you hold)</span>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-ink-100 p-2">
            {GRANTABLE.map((r) => (
              <div key={r.key} className="text-xs"><span className="font-medium">{r.label}</span><div className="flex flex-wrap gap-x-3">{r.actions.map((a) => { const p = `${r.key}:${a}`; return <label key={p} className="flex items-center gap-1"><input type="checkbox" checked={f.permissions.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />{IAM_ACTION_LABELS[a]}</label>; })}</div></div>
            ))}
          </div>
        </div>
        <div>
          <Input label="Limit to organizations (search; none = all)" value={orgQ} onChange={(e) => setOrgQ(e.target.value)} />
          {hits && orgQ && <div className="mt-1 flex flex-wrap gap-1">{hits.map((o) => <button key={o.id} className="rounded-full border border-ink-100 px-2 py-0.5 text-xs hover:bg-ink-50" onClick={() => { setOrgNames({ ...orgNames, [o.id]: o.name }); setF({ ...f, organizationIds: Array.from(new Set([...f.organizationIds, o.id])) }); setOrgQ(''); }}>+ {o.name}</button>)}</div>}
          <div className="mt-1 flex flex-wrap gap-1">{f.organizationIds.map((o) => <span key={o} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs">{orgNames[o] || o.slice(0, 8)} <button onClick={() => setF({ ...f, organizationIds: f.organizationIds.filter((x) => x !== o) })}>×</button></span>)}</div>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || (!account && f.name.trim().length < 2)} onClick={save}>{account ? 'Save' : 'Create'}</Button></div>
      </div>
    </Modal>
  );
}

function KeyForm({ account, onClose, onCreated }: { account: ServiceAccount; onClose: () => void; onCreated: (key: string) => Promise<void> }) {
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ name: 'Production', days: '90' });
  return (
    <Modal open onClose={onClose} title={`New API key for ${account.name}`}>
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <Input label="Key name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Expires in (days)" type="number" min={1} max={3650} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || f.name.trim().length < 2 || !(Number(f.days) >= 1)} onClick={() => run(async () => { const r = await api.post<{ key: string }>(`/admin/iam/service-accounts/${account.id}/keys`, { name: f.name.trim(), expiresInDays: Math.round(Number(f.days)) }); await onCreated(r.key); })}>Create key</Button></div>
      </div>
    </Modal>
  );
}
