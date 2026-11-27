import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { PACKAGED_CATEGORY_LABELS, PACKAGED_REVIEW_LABELS, PACKAGED_STORAGE_LABELS, type PackagedReviewStatus } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { Pills, StatTile } from '@/ops';

interface Row { menuItemId: string; name: string; priceCents: number; size: string | null; organizationName: string | null; firstParty: boolean; locationName: string | null; gtin: string | null; brandName: string | null; category: string; storage: string; ingredientsText: string | null; allergens: string[]; reviewStatus: PackagedReviewStatus; reviewNote: string | null }
interface Ov { review: Record<string, number>; stock: { units: number }; expiringIn7Days: { units: number }; openRecalls: number; policy: { enabled: boolean } }

/** Packaged goods on the phone: review queue (approve / reject / suspend) and the headline numbers. */
export default function OpsPackaged() {
  const { can } = useSession();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const { data: ov, reload: reloadOv } = useApi<Ov>('/admin/packaged', { poll: 60000 });
  const { data, reload } = useApi<Row[]>(`/admin/packaged/products?status=${status}`, { deps: [status] });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const decide = (id: string, decision: 'APPROVE' | 'REJECT' | 'SUSPEND') => run(async () => { await api.post(`/admin/packaged/products/${id}/review`, { decision, note: note || 'Label and details checked' }); setNote(''); reload(); reloadOv(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {ov && !ov.policy.enabled && <Card><Text style={{ color: C.bad }}>Kill switch on: packaged goods are sold out everywhere.</Text></Card>}
      {ov && <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}><StatTile label="Waiting" value={ov.review.PENDING ?? 0} /><StatTile label="Units" value={ov.stock.units} /><StatTile label="Recalls" value={ov.openRecalls} /></View>}
      <Pills value={status} onChange={setStatus} options={[{ id: 'PENDING', label: 'Waiting' }, { id: 'APPROVED', label: 'Live' }, { id: 'REJECTED', label: 'Rejected' }]} />
      <ErrorText msg={error} />
      {data?.map((r) => (
        <Card key={r.menuItemId} title={r.name}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={PACKAGED_REVIEW_LABELS[r.reviewStatus].toUpperCase()} tone={r.reviewStatus === 'APPROVED' ? 'good' : r.reviewStatus === 'PENDING' ? 'warn' : 'bad'} />{r.firstParty && <Badge text="GUTAD" tone="info" />}</View>
          <Muted>{r.organizationName} · {r.locationName}</Muted>
          <Muted>{[r.brandName, r.size, PACKAGED_CATEGORY_LABELS[r.category as 'PANTRY'], PACKAGED_STORAGE_LABELS[r.storage as 'AMBIENT'], money(r.priceCents)].filter(Boolean).join(' · ')}</Muted>
          {r.gtin && <Muted>Barcode {r.gtin}</Muted>}
          <Text style={{ color: C.ink7, marginTop: 4 }}>Ingredients: {r.ingredientsText || '—'}</Text>
          <Text style={{ color: C.ink7 }}>Allergens: {r.allergens.join(', ') || 'none declared'}</Text>
          {r.reviewNote && <Muted>Note: {r.reviewNote}</Muted>}
          {can('catalog.manage') && (
            <>
              <Input label="Note to the store (required to reject or suspend)" value={note} onChangeText={setNote} />
              {r.reviewStatus !== 'APPROVED' && <Button title="Approve" onPress={() => decide(r.menuItemId, 'APPROVE')} />}
              {r.reviewStatus === 'PENDING' && <Button title="Reject" variant="danger" disabled={note.trim().length < 3} onPress={() => decide(r.menuItemId, 'REJECT')} />}
              {r.reviewStatus === 'APPROVED' && <Button title="Suspend" variant="danger" disabled={note.trim().length < 3} onPress={() => decide(r.menuItemId, 'SUSPEND')} />}
            </>
          )}
        </Card>
      ))}
      {data && !data.length && <Card><Muted>Nothing here.</Muted></Card>}
    </ScrollView>
  );
}
