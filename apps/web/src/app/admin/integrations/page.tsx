'use client';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Stat, Table } from '@/components/ui';

export default function AdminIntegrations() {
  const { data: h, reload } = useApi<{ ok: boolean; db: boolean; redis: boolean; outboxBacklog: number; notificationBacklog: number; unacknowledgedOrders: number; failedPayouts: number; uptimeSec: number }>('/health', { poll: 10000 });
  const { data: ih, reload: reloadIh } = useApi<{ failedInbox: { id: string; provider: string; type: string; error: string | null; receivedAt: string }[]; stuckOutbox: { id: string; topic: string; lastError: string | null; attempts: number }[]; erroredIntegrations: { id: string; provider: string; lastError: string | null }[]; offlineDevices: number }>('/admin/integrations/health', { poll: 15000 });
  const { run, error } = useAction();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Monitoring</h1>
      {h && <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><Stat label="API" value={h.ok ? 'OK' : 'DEGRADED'} hint={`db ${h.db ? '✓' : '✗'} redis ${h.redis ? '✓' : '✗'}`} /><Stat label="Outbox backlog" value={h.outboxBacklog} /><Stat label="Notification backlog" value={h.notificationBacklog} /><Stat label="Unacked orders" value={h.unacknowledgedOrders} hint="> 10 min" /><Stat label="Failed/held payouts" value={h.failedPayouts} /><Stat label="Uptime" value={`${Math.round(h.uptimeSec / 60)}m`} /></div>}
      {error && <Alert>{error}</Alert>}
      <Card title="Failed inbound events (webhooks) — replayable"><Table rows={ih?.failedInbox || []} empty="No failed inbound events." cols={[{ key: 'p', label: 'Provider', render: (r) => r.provider }, { key: 't', label: 'Type', render: (r) => r.type }, { key: 'e', label: 'Error', render: (r) => <span className="text-xs text-red-600">{r.error}</span> }, { key: 'a', label: 'At', render: (r) => when(r.receivedAt) }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/admin/inbox/${r.id}/replay`, {}); reloadIh(); })}>Replay</Button> }]} /></Card>
      <Card title="Stuck outbound events"><Table rows={ih?.stuckOutbox || []} empty="Outbox healthy." cols={[{ key: 't', label: 'Topic', render: (r) => r.topic }, { key: 'e', label: 'Error', render: (r) => <span className="text-xs text-red-600">{r.lastError}</span> }, { key: 'n', label: 'Attempts', render: (r) => r.attempts }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/admin/outbox/${r.id}/replay`, {}); reloadIh(); reload(); })}>Retry</Button> }]} /></Card>
      <Card title="Integrations in error"><Table rows={ih?.erroredIntegrations || []} empty="All integrations healthy." cols={[{ key: 'p', label: 'Provider', render: (r) => r.provider }, { key: 'e', label: 'Last error', render: (r) => r.lastError }]} /><p className="mt-2 text-xs text-ink-500">Offline devices: {ih?.offlineDevices ?? 0}</p></Card>
    </div>
  );
}
