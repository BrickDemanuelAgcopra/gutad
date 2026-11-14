'use client';
import { useState } from 'react';
import { SECURITY_ALERT_TYPES, type SecurityAlertType } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Select, Table } from '@/components/ui';

interface SecurityAlert { id: string; type: string; severity: string; title: string; detail: string | null; subjectEmail: string | null; acknowledgedAt: string | null; createdAt: string }

const SEVERITY_TONE: Record<string, 'bad' | 'warn' | 'info' | 'neutral'> = { CRITICAL: 'bad', HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' };

export function AlertsTab({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(true);
  const [type, setType] = useState('');
  const qs = new URLSearchParams({ ...(open ? { open: 'true' } : {}), ...(type ? { type } : {}) }).toString();
  const { data, reload } = useApi<SecurityAlert[]>(`/admin/iam/alerts${qs ? `?${qs}` : ''}`, { deps: [qs], poll: 30000 });
  const { run, error, busy } = useAction();
  const ack = (id: string) => run(async () => { await api.post(`/admin/iam/alerts/${id}/ack`, {}); await reload(); onChange(); });
  const unacked = (data || []).filter((a) => !a.acknowledgedAt).length;
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <Select value={open ? 'open' : 'all'} onChange={(e) => setOpen(e.target.value === 'open')}><option value="open">Not acknowledged</option><option value="all">All alerts</option></Select>
        <Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Every type</option>{(Object.keys(SECURITY_ALERT_TYPES) as SecurityAlertType[]).map((t) => <option key={t} value={t}>{SECURITY_ALERT_TYPES[t]}</option>)}</Select>
        <div className="flex-1" />
        <Button variant="secondary" disabled={busy || !unacked} onClick={() => ack('all')}>Acknowledge all</Button>
      </div>
      <Table rows={data || []} empty={open ? 'No open security alerts.' : 'No security alerts.'} cols={[
        { key: 's', label: 'Severity', render: (a) => <Badge tone={SEVERITY_TONE[a.severity] || 'neutral'}>{a.severity}</Badge> },
        { key: 't', label: 'Type', render: (a) => <span className="text-xs">{SECURITY_ALERT_TYPES[a.type as SecurityAlertType] || a.type}</span> },
        { key: 'w', label: 'What happened', render: (a) => <span><span className="font-medium">{a.title}</span>{a.detail && <span className="block text-xs text-ink-500">{a.detail}</span>}{a.subjectEmail && <span className="block text-xs text-ink-500">Person: {a.subjectEmail}</span>}</span> },
        { key: 'c', label: 'When', render: (a) => <span className="text-xs">{when(a.createdAt)}</span> },
        { key: 'a', label: '', render: (a) => a.acknowledgedAt ? <span className="text-xs text-emerald-700">✓ {when(a.acknowledgedAt)}</span> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => ack(a.id)}>Acknowledge</Button> },
      ]} />
    </div>
  );
}
