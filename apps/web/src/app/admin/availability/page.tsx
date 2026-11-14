'use client';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Table } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface Av { soldOut: { itemId: string; name: string; until: string | null; locationId: string; locationName: string }[]; pausedLocations: { id: string; name: string; pausedReason: string | null; pausedUntil: string | null; status: string }[]; stationsDown: { id: string; code: string; name: string; kitchen: string }[] }

export default function Availability() {
  const { can } = useSession();
  const { data, reload } = useApi<Av>('/admin/availability', { poll: 30000 });
  const { run, error } = useAction();
  return (
    <div className="space-y-4">
      <SectionTitle title="Availability" hint="Temporarily unavailable items, paused stores and stations that are down, across every merchant you can see." />
      {error && <Alert>{error}</Alert>}
      <Card title={`Paused locations (${data?.pausedLocations.length ?? 0})`}>
        <Table rows={data?.pausedLocations || []} empty="Nothing paused." cols={[{ key: 'n', label: 'Location', render: (l) => <a className="underline" href={`/admin/locations/${l.id}`}>{l.name}</a> }, { key: 'r', label: 'Reason', render: (l) => <span className="text-xs">{l.pausedReason}</span> }, { key: 'u', label: 'Until', render: (l) => l.pausedUntil ? when(l.pausedUntil) : 'no reopening time' }, { key: 'a', label: '', render: (l) => can('ops.manage') ? <Button size="sm" variant="secondary" onClick={() => { const reason = askReason(`restarting ${l.name}`); if (reason) run(async () => { await api.post(`/locations/${l.id}/restart`, { reason }); reload(); }); }}>Restart</Button> : null }]} />
      </Card>
      <Card title={`Sold-out items (${data?.soldOut.length ?? 0})`}>
        <Table rows={data?.soldOut || []} empty="Nothing sold out." cols={[{ key: 'i', label: 'Item', render: (s) => s.name }, { key: 'l', label: 'Location', render: (s) => s.locationName }, { key: 'u', label: 'Back', render: (s) => s.until ? when(s.until) : 'until switched back on' }, { key: 'a', label: '', render: (s) => can('ops.manage') ? <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/items/${s.itemId}/sold-out`, { soldOut: false }); reload(); })}>Make available</Button> : null }]} />
      </Card>
      <Card title={`Stations down (${data?.stationsDown.length ?? 0})`}>
        <Table rows={data?.stationsDown || []} empty="All stations available." cols={[{ key: 'k', label: 'Kitchen', render: (s) => s.kitchen }, { key: 's', label: 'Station', render: (s) => `${s.code} · ${s.name}` }]} />
      </Card>
    </div>
  );
}
