'use client';
import { useState } from 'react';
import { money } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Select, Table, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { Devices, Equipment } from '@/components/team';

/** Workforce & equipment across the platform: equipment status and service, automated equipment, device health, labor by location. */
export default function AdminWorkforce() {
  const [tab, setTab] = useState('equipment');
  return (
    <div className="space-y-4">
      <SectionTitle title="Workforce & equipment" hint="Equipment outages and service, automated-equipment software and faults (record and escalate only), device health, labor against order volume." />
      <Tabs tabs={[{ id: 'equipment', label: 'Equipment' }, { id: 'devices', label: 'Devices' }, { id: 'labor', label: 'Labor vs volume' }]} active={tab} onChange={setTab} />
      {tab === 'equipment' && <Equipment />}
      {tab === 'devices' && <Devices />}
      {tab === 'labor' && <Labor />}
    </div>
  );
}

function Labor() {
  const { data: locs } = useApi<{ locations: { id: string; name: string }[] }>('/admin/delivery/network');
  const [l, setL] = useState('');
  const { data } = useApi<{ day: string; orders: number; salesCents: number; laborHours: number; laborCents: number; ordersPerLaborHour: number | null; laborPctOfSales: number | null }[]>(l ? `/locations/${l}/labor-report?days=14` : null, { deps: [l] });
  return (
    <div className="space-y-3">
      <Select label="Location" value={l} onChange={(e) => setL(e.target.value)}><option value="">Choose…</option>{locs?.locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      {l && <Table rows={data || []} empty="No data." cols={[{ key: 'd', label: 'Day', render: (x) => new Date(x.day).toLocaleDateString() }, { key: 'o', label: 'Orders', render: (x) => x.orders }, { key: 's', label: 'Sales', render: (x) => money(x.salesCents) }, { key: 'h', label: 'Labor hours', render: (x) => x.laborHours }, { key: 'c', label: 'Labor cost', render: (x) => money(x.laborCents) }, { key: 'p', label: 'Orders / labor hour', render: (x) => x.ordersPerLaborHour ?? '—' }, { key: 'l', label: 'Labor %', render: (x) => (x.laborPctOfSales == null ? '—' : `${x.laborPctOfSales}%`) }]} />}
    </div>
  );
}
