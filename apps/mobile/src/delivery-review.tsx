import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { REVIEW_ISSUES, REVIEW_TAG_LABELS, REVIEW_TAGS_NEGATIVE, REVIEW_TAGS_POSITIVE, type ReviewIssue } from '@gutad/shared';
import { api, when } from './api';
import { useAction, useApi } from './hooks';
import { Button, C, Card, ErrorText, Input, Muted } from './ui';
import { Chips } from './chef-ui';

interface Review { rating: number; tags: string[]; comment: string | null; foodRating: number | null; packagingRating: number | null; issues: ReviewIssue[] }
interface ReviewState { eligible: boolean; reason: string | null; courierFirstName: string | null; review: Review | null; editableUntil: string | null }

function Stars({ value, onChange, size = 30 }: { value: number; onChange: (n: number) => void; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginVertical: 4 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`} onPress={() => onChange(n)} hitSlop={4}>
          <Text style={{ fontSize: size, color: n <= value ? C.brand : C.ink3 }}>★</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Rate the courier (separately from the food and packaging); serious problems open a support case. */
export function DeliveryReview({ orderId }: { orderId: string }) {
  const { data, reload } = useApi<ReviewState>(`/orders/${orderId}/delivery-review`);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<{ rating: number; tags: string[]; comment: string; foodRating: number; packagingRating: number; issues: ReviewIssue[] } | null>(null);
  const { run, error, busy } = useAction();
  if (!data) return null;
  if (!data.eligible && !data.review) return data.reason ? <Muted>{data.reason}</Muted> : null;
  const name = data.courierFirstName || 'your courier';
  const canEdit = !data.editableUntil || new Date(data.editableUntil) > new Date();
  const start = () => { const r = data.review; setF({ rating: r?.rating || 0, tags: r?.tags || [], comment: r?.comment || '', foodRating: r?.foodRating || 0, packagingRating: r?.packagingRating || 0, issues: r?.issues || [] }); setEditing(true); };

  if (data.review && !editing) {
    const r = data.review;
    return (
      <Card title="Your delivery rating">
        <Text style={{ fontSize: 22, color: C.brand }}>{'★'.repeat(r.rating)}<Text style={{ color: C.ink3 }}>{'★'.repeat(5 - r.rating)}</Text></Text>
        {r.tags.length > 0 && <Muted>{r.tags.map((t) => REVIEW_TAG_LABELS[t] || t).join(' · ')}</Muted>}
        {r.comment && <Text style={{ color: C.ink7 }}>“{r.comment}”</Text>}
        {(r.foodRating || r.packagingRating) ? <Muted>Food {r.foodRating || '—'}/5 · packaging {r.packagingRating || '—'}/5</Muted> : null}
        {r.issues.length > 0 && <Muted>Reported: {r.issues.map((i) => REVIEW_ISSUES[i] || i).join(', ')}. Support will follow up.</Muted>}
        {canEdit && <Button title="Edit" variant="ghost" onPress={start} />}
        {canEdit && data.editableUntil && <Muted>You can change this until {when(data.editableUntil)}.</Muted>}
      </Card>
    );
  }
  if (!editing || !f) {
    return (
      <Card title="Rate your delivery">
        <Muted>How was the delivery with {name}?</Muted>
        <Stars value={0} onChange={(n) => { start(); setF((p) => ({ ...(p || { tags: [], comment: '', foodRating: 0, packagingRating: 0, issues: [] }), rating: n })); }} />
      </Card>
    );
  }
  const tagOptions = (f.rating >= 4 ? REVIEW_TAGS_POSITIVE : f.rating > 0 ? REVIEW_TAGS_NEGATIVE : []).map((t) => ({ value: t as string, label: REVIEW_TAG_LABELS[t] }));
  const setRating = (n: number) => setF({ ...f, rating: n, tags: (n >= 4) === (f.rating >= 4) ? f.tags : [] });
  return (
    <Card title="Rate your delivery">
      <Muted>The courier: {name}</Muted>
      <Stars value={f.rating} onChange={setRating} />
      {tagOptions.length > 0 && <><Muted>{f.rating >= 4 ? 'What went well?' : 'What could be better?'}</Muted><Chips values={f.tags} onChange={(tags) => setF({ ...f, tags })} options={tagOptions} /></>}
      <Input label="Comment (optional)" multiline value={f.comment} onChangeText={(comment) => setF({ ...f, comment })} />
      <Muted>The food (rated separately, not the courier)</Muted>
      <Stars size={22} value={f.foodRating} onChange={(foodRating) => setF({ ...f, foodRating })} />
      <Muted>The packaging</Muted>
      <Stars size={22} value={f.packagingRating} onChange={(packagingRating) => setF({ ...f, packagingRating })} />
      <Muted>Any of these? Each opens a support case.</Muted>
      <Chips values={f.issues} onChange={(issues) => setF({ ...f, issues })} options={(Object.keys(REVIEW_ISSUES) as ReviewIssue[]).map((k) => ({ value: k, label: REVIEW_ISSUES[k] }))} />
      <ErrorText msg={error} />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Button title={busy ? 'Sending…' : 'Send rating'} disabled={busy || !f.rating} onPress={() => run(async () => {
          await api.post(`/orders/${orderId}/delivery-review`, { rating: f.rating, tags: f.tags, comment: f.comment.trim() || undefined, foodRating: f.foodRating || undefined, packagingRating: f.packagingRating || undefined, issues: f.issues.length ? f.issues : undefined });
          setEditing(false);
          await reload();
        })} />
        <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} />
      </View>
    </Card>
  );
}
