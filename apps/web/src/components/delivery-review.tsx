'use client';
import { useState } from 'react';
import { REVIEW_ISSUES, REVIEW_TAG_LABELS, REVIEW_TAGS_NEGATIVE, REVIEW_TAGS_POSITIVE, type ReviewIssue } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Textarea } from '@/components/ui';

interface Review { rating: number; tags: string[]; comment: string | null; foodRating: number | null; packagingRating: number | null; issues: string[] }
interface ReviewState { eligible: boolean; reason: string | null; courierFirstName: string | null; review: Review | null; editableUntil: string | null }

function Stars({ value, onChange, size = 'text-2xl', label }: { value: number; onChange: (n: number) => void; size?: string; label: string }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => onChange(n)} className={`${size} ${n <= value ? 'text-amber-500' : 'text-ink-100'}`}>★</button>)}
    </div>
  );
}

/** Customer rates the courier (separately from the food and packaging); serious issues open a support case. */
export function DeliveryReviewCard({ orderId }: { orderId: string }) {
  const { data, reload } = useApi<ReviewState>(`/orders/${orderId}/delivery-review`);
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  const editable = !!data.review && !!data.editableUntil && new Date(data.editableUntil) > new Date();
  if (!data.eligible && !editable) return null;
  const who = data.courierFirstName || 'your courier';
  if (data.review && !editing) {
    return (
      <Card title="Rate your delivery">
        <p className="text-sm">Thanks for rating {who}: <span className="text-amber-500">{'★'.repeat(data.review.rating)}</span><span className="text-ink-100">{'★'.repeat(5 - data.review.rating)}</span></p>
        {data.review.issues?.length > 0 && <p className="mt-1 text-xs text-ink-500">Support has your report and will follow up.</p>}
        {editable && <Button className="mt-2" size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit{data.editableUntil ? ` (until ${when(data.editableUntil)})` : ''}</Button>}
      </Card>
    );
  }
  return <ReviewForm orderId={orderId} who={who} initial={data.review} onDone={async () => { setEditing(false); await reload(); }} />;
}

function ReviewForm({ orderId, who, initial, onDone }: { orderId: string; who: string; initial: Review | null; onDone: () => Promise<void> }) {
  const [rating, setRating] = useState(initial?.rating || 0);
  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [comment, setComment] = useState(initial?.comment || '');
  const [foodRating, setFood] = useState(initial?.foodRating || 0);
  const [packagingRating, setPack] = useState(initial?.packagingRating || 0);
  const [issues, setIssues] = useState<string[]>(initial?.issues || []);
  const { run, error, busy } = useAction();
  const tagSet: readonly string[] = rating >= 4 ? REVIEW_TAGS_POSITIVE : rating > 0 ? REVIEW_TAGS_NEGATIVE : [];
  const shownTags = tags.filter((t) => tagSet.includes(t));
  const toggle = (list: string[], set: (v: string[]) => void, k: string) => set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  return (
    <Card title="Rate your delivery">
      <div className="space-y-3 text-sm">
        <div><p className="mb-1">How was {who}?</p><Stars label="Courier rating" value={rating} onChange={setRating} /></div>
        {tagSet.length > 0 && <div className="flex flex-wrap gap-1">{tagSet.map((t) => <button key={t} type="button" onClick={() => toggle(tags, setTags, t)} className={`rounded-full border px-3 py-1 text-xs ${tags.includes(t) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-100 text-ink-700'}`}>{REVIEW_TAG_LABELS[t]}</button>)}</div>}
        <Textarea rows={2} label="Anything else? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="mb-1 text-xs text-ink-500">Food (optional)</p><Stars size="text-xl" label="Food rating" value={foodRating} onChange={setFood} /></div>
          <div><p className="mb-1 text-xs text-ink-500">Packaging (optional)</p><Stars size="text-xl" label="Packaging rating" value={packagingRating} onChange={setPack} /></div>
        </div>
        <div>
          <p className="mb-1 text-xs text-ink-500">Did something go wrong? Ticking these opens a support case.</p>
          {(Object.keys(REVIEW_ISSUES) as ReviewIssue[]).map((k) => <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={issues.includes(k)} onChange={() => toggle(issues, setIssues, k)} /> {REVIEW_ISSUES[k]}</label>)}
        </div>
        {error && <Alert>{error}</Alert>}
        <Button disabled={busy || rating < 1} onClick={() => run(async () => {
          await api.post(`/orders/${orderId}/delivery-review`, { rating, tags: shownTags, comment: comment.trim() || undefined, foodRating: foodRating || undefined, packagingRating: packagingRating || undefined, issues });
          await onDone();
        })}>{busy ? 'Sending…' : initial ? 'Update rating' : 'Send rating'}</Button>
      </div>
    </Card>
  );
}
