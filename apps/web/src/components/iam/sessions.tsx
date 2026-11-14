'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { Notice, SUPERADMIN, useStepUp, type LoginEvent, type SessionRow } from './common';

const OUTCOMES = ['SUCCESS', 'FAILURE', 'LOCKED', 'BLOCKED', 'MFA_FAILURE'];

export function SessionsTab() {
  const { can, user } = useSession();
  const manage = can('security.manage');
  const superadmin = !!user && (user.roles.includes(SUPERADMIN) || !!user.accessRoles?.some((r) => r.key === SUPERADMIN));
  const { data: sessions, reload } = useApi<SessionRow[]>('/admin/iam/sessions', { poll: 30000 });
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const [f, setF] = useState({ outcome: '', suspicious: false, email: '' });
  const qs = new URLSearchParams({ ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.suspicious ? { suspicious: 'true' } : {}), ...(f.email ? { email: f.email } : {}) }).toString();
  const { data: logins } = useApi<LoginEvent[]>(`/admin/iam/login-events${qs ? `?${qs}` : ''}`, { deps: [qs] });
  const signOutAll = () => {
    if (!window.confirm('Sign out every staff member except you? Everyone must sign in again.')) return;
    const reason = askReason('signing out all staff');
    if (!reason) return;
    void run(async () => { const r = await withStepUp((stepUp) => api.post<{ users: number; sessions: number }>('/admin/iam/sessions/revoke-all', { reason, stepUp })); setNotice(`Ended ${r.sessions} session(s) for ${r.users} person(s).`); await reload(); });
  };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Notice text={notice} onClose={() => setNotice(null)} />
      <Card title="Active staff sessions" action={manage && superadmin ? <Button size="sm" variant="danger" disabled={busy} onClick={signOutAll}>Sign out all staff</Button> : undefined}>
        <Table rows={sessions || []} empty="No active sessions." cols={[
          { key: 'p', label: 'Person', render: (s) => <span>{s.name || s.email}{s.name && <span className="block text-xs text-ink-500">{s.email}</span>}{s.current && <Badge tone="info">this session</Badge>}</span> },
          { key: 'c', label: 'Client', render: (s) => <span className="text-xs">{s.client || 'web'} · {s.amr.join('+') || 'token'}<span className="block max-w-xs truncate text-ink-500">{s.userAgent}</span></span> },
          { key: 'i', label: 'IP', render: (s) => <span className="text-xs">{s.ip || '—'}</span> },
          { key: 'l', label: 'Last seen', render: (s) => <span className="text-xs">{when(s.lastSeenAt)}</span> },
          { key: 'e', label: 'Expires', render: (s) => <span className="text-xs">{when(s.expiresAt)}</span> },
          { key: 'a', label: '', render: (s) => manage && !s.current ? <Button size="sm" variant="ghost" className="text-red-600" onClick={() => { const reason = askReason('ending this session'); if (reason) void run(async () => { await api.post(`/admin/iam/sessions/${s.id}/revoke`, { reason }); await reload(); }); }}>End</Button> : null },
        ]} />
      </Card>
      <Card title="Sign-in log">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Input className="min-w-[200px] flex-1" placeholder="Email contains" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}><option value="">Any outcome</option>{OUTCOMES.map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</Select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.suspicious} onChange={(e) => setF({ ...f, suspicious: e.target.checked })} /> Suspicious only</label>
        </div>
        <Table rows={logins || []} empty="No sign-in events." cols={[
          { key: 't', label: 'When', render: (l) => <span className="text-xs">{when(l.createdAt)}</span> },
          { key: 'e', label: 'Email', render: (l) => <span className="text-xs">{l.email || '—'}</span> },
          { key: 'o', label: 'Outcome', render: (l) => <span className="flex flex-wrap gap-1"><Badge tone={l.outcome === 'SUCCESS' ? 'good' : 'bad'}>{l.outcome}</Badge>{l.suspicious && <Badge tone="warn">suspicious</Badge>}</span> },
          { key: 'm', label: 'Method', render: (l) => <span className="text-xs">{l.method}{l.reason && <span className="block text-ink-500">{l.reason}</span>}</span> },
          { key: 'i', label: 'IP / device', render: (l) => <span className="text-xs">{l.ip || '—'}<span className="block max-w-xs truncate text-ink-500">{l.userAgent}</span></span> },
        ]} />
      </Card>
    </div>
  );
}
