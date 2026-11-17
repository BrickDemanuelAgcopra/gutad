import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CHEF_REQUEST_REASONS, CHEF_REQUEST_STATUS_LABELS, CHEF_REQUEST_TYPES, type ChefQuoteCartLine, type ChefRequestDetail, type ChefRequestMessage, type ChefRequestQuote, type ChefRequestStatus, type ChefRequestSummary } from '@gutad/shared';
import { money, when } from './api';
import { useCart } from './cart';
import { Badge, Button, C, Card, Muted, s } from './ui';
import { hhmmLabel, ymdLabel } from './date-slot-picker';

/** Detail as returned by GET /chef-requests/:id (the cart line is present once accepted, until paid). */
export type RequestDetail = ChefRequestDetail & { cartLine?: ChefQuoteCartLine | null };

export const requestTone = (st: ChefRequestStatus): 'neutral' | 'good' | 'warn' | 'bad' | 'info' => (st === 'QUOTED' || st === 'ACCEPTED' ? 'info' : st === 'ORDERED' ? 'good' : st === 'PENDING' || st === 'NEEDS_INFO' ? 'warn' : 'neutral');
export const statusLabel = (st: ChefRequestStatus) => CHEF_REQUEST_STATUS_LABELS[st] || st;
export const dateTime = (d: string, t?: string | null) => `${ymdLabel(d)}${t ? ` · ${hhmmLabel(t)}` : ''}`;
const QUOTE_STATUS: Record<ChefRequestQuote['status'], string> = { SENT: 'Open', ACCEPTED: 'Accepted', SUPERSEDED: 'Replaced', REVISION_REQUESTED: 'Revision asked', DECLINED: 'Declined', EXPIRED: 'Expired', ORDERED: 'Ordered' };
/** "Reply by …" / "Overdue" text for a deadline. */
export const deadlineText = (iso: string | null) => (!iso ? null : new Date(iso) < new Date() ? `Overdue since ${when(iso)}` : `Reply by ${when(iso)}`);

/** Adds an accepted quote's line to the cart (quantity and date fixed) and opens checkout. */
export function useQuoteCheckout() {
  const { add } = useCart();
  const router = useRouter();
  return (l: ChefQuoteCartLine) => {
    add({ id: l.location.id, slug: l.location.slug, name: `${l.chefName} (Gutad Chef Network)` }, { menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifierOptionIds: l.modifierOptionIds, modifierNames: l.modifierNames, modifiersCents: 0, chefRequestQuoteId: l.chefRequestQuoteId, serviceDate: l.serviceDate, serviceTime: l.serviceTime }, { park: true });
    router.push('/checkout');
  };
}

/** One row in a request list. */
export function RequestRow({ r, onPress, showCustomer, showChef }: { r: ChefRequestSummary; onPress: () => void; showCustomer?: boolean; showChef?: boolean }) {
  const dl = r.status === 'PENDING' || r.status === 'NEEDS_INFO' ? deadlineText(r.respondBy) : null;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Card>
        <View style={[s.row, { gap: 8 }]}><Text style={{ fontWeight: '700', flex: 1, color: C.ink }} numberOfLines={2}>{r.dish.title}</Text><Badge text={statusLabel(r.status)} tone={requestTone(r.status)} /></View>
        <Muted>{r.code} · {CHEF_REQUEST_TYPES[r.requestType]}{r.ingredient ? `: ${r.ingredient}` : ''} · {r.servings} serving{r.servings === 1 ? '' : 's'} · {ymdLabel(r.requestedDate)}</Muted>
        {(showCustomer || showChef) && <Muted>{[showCustomer ? `From ${r.customer?.name || 'a customer'}` : '', showChef ? r.chef.displayName : ''].filter(Boolean).join(' · ')}</Muted>}
        {r.reason === 'ALLERGY' && <Text style={{ color: C.bad, fontSize: 12, fontWeight: '600' }}>Allergy</Text>}
        <Text numberOfLines={2} style={{ color: C.ink7, marginTop: 2 }}>{r.details}</Text>
        {r.latestQuote && <Text style={{ marginTop: 4, fontWeight: '600' }}>Quote v{r.latestQuote.version}: {money(r.latestQuote.totalCents)}</Text>}
        {dl && <Text style={{ color: dl.startsWith('Overdue') ? C.bad : C.warn, fontSize: 12, marginTop: 2 }}>{dl}</Text>}
      </Card>
    </Pressable>
  );
}

/** What the customer asked for. */
export function RequestCard({ r }: { r: RequestDetail }) {
  const dl = r.status === 'PENDING' || r.status === 'NEEDS_INFO' ? deadlineText(r.respondBy) : null;
  return (
    <Card>
      <View style={[s.row, { gap: 8 }]}><Text style={{ fontSize: 18, fontWeight: '700', flex: 1, color: C.ink }}>{r.dish.title}</Text><Badge text={statusLabel(r.status)} tone={requestTone(r.status)} /></View>
      <Muted>{r.code} · {r.chef.displayName}{r.customer?.name && r.viewerRole !== 'CUSTOMER' ? ` · for ${r.customer.name}` : ''}</Muted>
      <Text style={[s.label, { marginTop: 8 }]}>{CHEF_REQUEST_TYPES[r.requestType]}{r.ingredient ? `: ${r.ingredient}` : ''}</Text>
      <Text style={{ color: C.ink }}>{r.details}</Text>
      {r.baseOptionNames.length > 0 && <Muted>Chosen options: {r.baseOptionNames.join(', ')}</Muted>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        <Badge text={CHEF_REQUEST_REASONS[r.reason]} tone={r.reason === 'ALLERGY' ? 'bad' : 'neutral'} />
        <Badge text={`${r.servings} serving${r.servings === 1 ? '' : 's'}`} />
        <Badge text={dateTime(r.requestedDate, r.requestedTime)} />
        {r.budgetCents !== null && <Badge text={`Budget ${money(r.budgetCents)}`} />}
        <Badge text={r.alternativesOk ? 'Alternatives OK' : 'No alternatives'} tone={r.alternativesOk ? 'good' : 'neutral'} />
      </View>
      {r.reason === 'ALLERGY' && <Text style={{ color: C.bad, fontSize: 12, marginTop: 6 }}>Allergy: check every ingredient and the kitchen setup before quoting.</Text>}
      {r.alternativesOk && r.alternativesNote && <Muted>Alternatives: {r.alternativesNote}</Muted>}
      {dl && <Text style={{ color: dl.startsWith('Overdue') ? C.bad : C.warn, fontSize: 12, marginTop: 6 }}>{dl}</Text>}
    </Card>
  );
}

/** One quote version. `action` renders under it (e.g. Accept & pay). */
export function QuoteCard({ q, action }: { q: ChefRequestQuote; action?: ReactNode }) {
  const live = q.status === 'SENT' || q.status === 'ACCEPTED';
  return (
    <Card style={live ? { borderColor: C.brand } : { opacity: 0.75 }}>
      <View style={[s.row, { gap: 8 }]}><Text style={{ fontWeight: '700', flex: 1, color: C.ink }}>{q.kind === 'ALTERNATIVE' ? 'Suggested alternative' : 'Quote'} · v{q.version}</Text><Badge text={QUOTE_STATUS[q.status]} tone={q.status === 'SENT' ? 'info' : q.status === 'ACCEPTED' || q.status === 'ORDERED' ? 'good' : 'neutral'} /></View>
      {q.kind === 'ALTERNATIVE' && <Text style={{ fontWeight: '600', marginTop: 4 }}>{q.dish.title}</Text>}
      <Text style={{ color: C.ink, marginTop: 4 }}>{q.changes}</Text>
      {!!q.portionDesc && <Muted>Portion: {q.portionDesc}</Muted>}
      <Text style={{ fontWeight: '700', marginTop: 6 }}>{q.quantity} × {money(q.unitPriceCents)} = {money(q.totalCents)}</Text>
      <Muted>Food price before tax, fees and delivery</Muted>
      <Text style={{ color: q.allergens.length ? C.bad : C.ink7, fontSize: 13, marginTop: 4 }}>Allergens: {q.allergens.length ? q.allergens.map((a) => a.replace('_', ' ')).join(', ') : 'none declared'}</Text>
      {q.dietaryTags.length > 0 && <Muted>{q.dietaryTags.map((t) => t.replace('_', ' ')).join(', ')}</Muted>}
      <Muted>Cooked for {dateTime(q.serviceDate, q.serviceTime)}{q.prepMinutes ? ` · ${q.prepMinutes} min prep` : ''}</Muted>
      {q.note && <Text style={{ color: C.ink7, marginTop: 4 }}>“{q.note}”</Text>}
      {q.status === 'SENT' && <Text style={{ color: C.warn, fontSize: 12, marginTop: 4 }}>Valid until {when(q.expiresAt)}</Text>}
      {action}
    </Card>
  );
}

/** Messages, oldest first. */
export function Thread({ messages }: { messages: ChefRequestMessage[] }) {
  if (!messages.length) return null;
  return (
    <Card title="Messages">
      {messages.map((m) => m.authorRole === 'SYSTEM'
        ? <Text key={m.id} style={{ color: C.ink5, fontSize: 12, textAlign: 'center', marginVertical: 4 }}>{m.body} · {when(m.createdAt)}</Text>
        : <View key={m.id} style={{ marginVertical: 4, padding: 10, borderRadius: 12, backgroundColor: m.authorRole === 'CUSTOMER' ? C.bg : m.authorRole === 'STAFF' ? '#e0f2fe' : '#fff4ec' }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: C.ink7 }}>{m.authorName || (m.authorRole === 'CHEF' ? 'Chef' : m.authorRole === 'STAFF' ? 'Gutad' : 'Customer')} · <Text style={{ fontWeight: '400', color: C.ink5 }}>{when(m.createdAt)}</Text></Text>
          <Text style={{ color: C.ink }}>{m.body}</Text>
        </View>)}
    </Card>
  );
}

/** A text box with one send button (messages, revision notes, reasons). */
export function TextAction({ label, placeholder, button, min = 1, busy, onSend, variant = 'primary' }: { label?: string; placeholder?: string; button: string; min?: number; busy?: boolean; onSend: (text: string) => Promise<unknown>; variant?: 'primary' | 'secondary' | 'danger' }) {
  const [v, setV] = useState('');
  return (
    <View>
      {label && <Text style={s.label}>{label}</Text>}
      <TextInput multiline placeholder={placeholder} placeholderTextColor={C.ink3} value={v} onChangeText={setV} style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]} accessibilityLabel={label || placeholder} />
      <Button title={button} variant={variant} disabled={busy || v.trim().length < min} onPress={() => void onSend(v.trim()).then((ok) => { if (ok !== undefined) setV(''); })} />
    </View>
  );
}
