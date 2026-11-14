import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';

interface B { id: string; name: string; organizationName: string; ownershipType: string; ownerName: string | null; rightsStatus: string; blockedReason: string | null; authorizedChannels: string[] }
interface St { salesCents: number; orders: number; royalty: { royaltyCents: number }; quality: { reviews: number; avgScore: number | null; fails: number } }

/** Brands on the phone: rights status, this month's statement, stop or resume sales. */
export default function OpsBrands() {
  const { can } = useSession();
  const { data, reload } = useApi<B[]>('/admin/brands');
  const [open, setOpen] = useState<string | null>(null);
  const from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: st } = useApi<St>(open ? `/brands/${open}/statement?from=${encodeURIComponent(from)}` : null, { deps: [open] });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const commercial = can('merchants.manage') || can('catalog.manage');
  if (!data) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <ErrorText msg={error} />
      {data.map((b) => (
        <Card key={b.id}>
          <Pressable onPress={() => setOpen(open === b.id ? null : b.id)}>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{b.name}</Text><Badge text={b.blockedReason ? 'STOPPED' : 'SELLING'} tone={b.blockedReason ? 'bad' : 'good'} /></View>
            <Muted>{b.organizationName} · {b.ownershipType.toLowerCase().replace('_', ' ')}{b.ownerName ? ` · ${b.ownerName}` : ''}{b.authorizedChannels.length ? ` · ${b.authorizedChannels.join(', ').toLowerCase()}` : ''}</Muted>
            {b.blockedReason && <Muted>{b.blockedReason}</Muted>}
          </Pressable>
          {open === b.id && (
            <View style={{ marginTop: 8 }}>
              {st ? <Muted>This month: {money(st.salesCents)} · {st.orders} orders · royalty {money(st.royalty.royaltyCents)} · {st.quality.reviews} reviews (avg {st.quality.avgScore?.toFixed(1) ?? '—'}, {st.quality.fails} fails)</Muted> : <Loading />}
              {commercial && (
                <>
                  <Input label="Note" value={note} onChangeText={setNote} />
                  {b.rightsStatus === 'ACTIVE'
                    ? <Button title="Stop sales (suspend rights)" variant="danger" disabled={note.trim().length < 5} onPress={() => run(async () => { await api.patch(`/brands/${b.id}`, { rightsStatus: 'SUSPENDED', rightsNote: note }); setNote(''); reload(); })} />
                    : <Button title="Resume sales" onPress={() => run(async () => { await api.patch(`/brands/${b.id}`, { rightsStatus: 'ACTIVE', rightsNote: note || null }); setNote(''); reload(); })} />}
                </>
              )}
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}
