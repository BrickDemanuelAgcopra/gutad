'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { ExpoBoard, KitchenPerformance } from '@/components/kitchen';

interface K { id: string; name: string; organization: string; city: string; loadLevel: string; loadChangedAt: string | null; queued: number; inProgress: number; delayed: number; remakesToday: number; toPack: number; readyWaiting: number }
const tone = (l: string) => (l === 'NORMAL' ? 'good' : l === 'BUSY' ? 'warn' : 'bad') as 'good' | 'warn' | 'bad';

/** Kitchen operations across every kitchen: load & auto-throttle, queues, delays, remakes, packing backlog. */
export default function AdminKitchens() {
  const { data, reload } = useApi<K[]>('/admin/kitchens', { poll: 15000 });
  const { can } = useSession();
  const { run, error } = useAction();
  const [sel, setSel] = useState<{ id: string; view: 'expo' | 'perf' } | null>(null);
  return (
    <div className="space-y-4">
      <SectionTitle title="Kitchen operations" hint="Load is re-evaluated every minute. Busy kitchens quote longer prep times; overloaded kitchens stop taking ASAP orders until the queue recovers." action={can('kitchens.manage') ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post('/admin/jobs/kitchen-load', {}); await reload(); })}>Re-check load now</Button> : undefined} />
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No kitchens." cols={[
        { key: 'k', label: 'Kitchen', render: (k) => <span className="font-medium">{k.name}<span className="block text-xs text-ink-500">{k.organization} · {k.city}</span></span> },
        { key: 'l', label: 'Load', render: (k) => <span><Badge tone={tone(k.loadLevel)}>{k.loadLevel.toLowerCase()}</Badge>{k.loadChangedAt && <span className="block text-xs text-ink-500">since {when(k.loadChangedAt)}</span>}</span> },
        { key: 'q', label: 'Queued / cooking', render: (k) => `${k.queued} / ${k.inProgress}` },
        { key: 'd', label: 'Late tickets', render: (k) => <span className={k.delayed ? 'font-semibold text-red-700' : ''}>{k.delayed}</span> },
        { key: 'p', label: 'To pack', render: (k) => k.toPack },
        { key: 'w', label: 'Ready, waiting', render: (k) => k.readyWaiting },
        { key: 'r', label: 'Remakes today', render: (k) => k.remakesToday },
        { key: 'a', label: '', render: (k) => <span className="flex gap-2"><button className="text-xs underline" onClick={() => setSel({ id: k.id, view: 'expo' })}>Expo</button><button className="text-xs underline" onClick={() => setSel({ id: k.id, view: 'perf' })}>Performance</button></span> },
      ]} />
      {sel && <div className="space-y-2"><div className="flex items-center justify-between"><h2 className="font-semibold">{data?.find((k) => k.id === sel.id)?.name} · {sel.view === 'expo' ? 'expo' : 'performance'}</h2><Button size="sm" variant="ghost" onClick={() => setSel(null)}>Close</Button></div>{sel.view === 'expo' ? <ExpoBoard kitchenId={sel.id} /> : <KitchenPerformance kitchenId={sel.id} />}</div>}
    </div>
  );
}
