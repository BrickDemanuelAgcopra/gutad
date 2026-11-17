import { Alert, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CHEF_REQUEST_OPEN, type ChefQuoteCartLine } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { useState } from 'react';
import { StaffAlternative } from '@/staff-alternative';
import { QuoteCard, RequestCard, TextAction, Thread, useQuoteCheckout, type RequestDetail } from '@/chef-requests';

/** One special request: the customer's view (accept, revise, withdraw, reply) and Gutad staff's (extend, close). */
export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, ready } = useSession();
  const { data: r, setData, error, reload } = useApi<RequestDetail>(user ? `/chef-requests/${id}` : null, { deps: [user?.id], poll: 30000 });
  const { run, busy, error: actErr } = useAction();
  const checkout = useQuoteCheckout();
  const [suggesting, setSuggesting] = useState(false);
  if (!ready) return null;
  if (!user) return <View style={[s.screen, s.pad]}><Card title="Special request"><Muted>Sign in to see this request.</Muted><Button title="Sign in / create account" onPress={() => router.push('/login')} /></Card></View>;
  if (!r) return error ? <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View> : <Loading />;
  const staff = r.viewerRole === 'STAFF';
  const open = CHEF_REQUEST_OPEN.includes(r.status);
  const act = (fn: () => Promise<RequestDetail>) => run(async () => { const d = await fn(); setData(d); return d; });
  const accept = (quoteId: string) => run(async () => {
    const res = await api.post<{ request: RequestDetail; cartLine: ChefQuoteCartLine }>(`/chef-requests/${r.id}/accept`, { quoteId });
    setData({ ...res.request, cartLine: res.cartLine });
    checkout(res.cartLine);
  });
  const withdraw = () => Alert.alert('Withdraw this request?', 'The chef stops working on it. You can send a new request later.', [{ text: 'Keep it', style: 'cancel' }, { text: 'Withdraw', style: 'destructive', onPress: () => void act(() => api.post<RequestDetail>(`/chef-requests/${r.id}/withdraw`, {})) }]);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <RequestCard r={r} />
      <ErrorText msg={actErr} />
      {r.cartLine && !staff && (
        <Card style={{ borderColor: C.brand, backgroundColor: '#fff4ec' }}>
          <Text style={{ fontWeight: '700', color: C.ink }}>Accepted · {r.cartLine.quantity} × {money(r.cartLine.unitPriceCents)}</Text>
          <Muted>Pay to confirm your order. The quote’s price, servings and date are fixed.</Muted>
          <Button title="Continue to payment" onPress={() => checkout(r.cartLine!)} />
        </Card>
      )}
      {r.status === 'ORDERED' && r.orderId && <Card><Text style={{ color: C.good, fontWeight: '600' }}>Ordered</Text><Button variant="secondary" title="View order" onPress={() => router.push({ pathname: '/order/[id]', params: { id: r.orderId! } })} /></Card>}
      {r.quotes.length === 0 && r.status === 'PENDING' && <Card><Muted>{r.chef.displayName} will reply with a quote, a question or an alternative. Nothing is charged until you accept a quote.</Muted></Card>}
      {r.quotes.map((q, i) => (
        <QuoteCard key={q.id} q={q} action={i === 0 && q.status === 'SENT' && r.can.accept && !staff ? <Button disabled={busy} title={`Accept & pay ${money(q.totalCents)}`} onPress={() => void accept(q.id)} /> : undefined} />
      ))}
      <Thread messages={r.messages} />
      {!staff && r.can.message && <Card title={r.status === 'NEEDS_INFO' ? 'Answer the chef' : 'Message the chef'}><TextAction placeholder="Write a message" button="Send" busy={busy} onSend={(body) => act(() => api.post<RequestDetail>(`/chef-requests/${r.id}/messages`, { body }))} /></Card>}
      {!staff && r.can.revise && <Card title="Ask for a revision"><Muted>Tell the chef what to change in the quote.</Muted><TextAction placeholder="e.g. Could it be ready by 6 PM?" button="Request revision" variant="secondary" min={3} busy={busy} onSend={(note) => act(() => api.post<RequestDetail>(`/chef-requests/${r.id}/revise`, { note }))} /></Card>}
      {!staff && r.can.withdraw && <Button variant="ghost" disabled={busy} title="Withdraw request" onPress={withdraw} />}
      {staff && open && (
        <Card title="Gutad staff">
          <Button variant="secondary" disabled={busy} title="Extend deadline +24h" onPress={() => void act(() => api.post<RequestDetail>(`/admin/chef-requests/${r.id}/extend`, { hours: 24 }))} />
          {r.can.quote && r.alternativesOk && <Button variant="secondary" title={suggesting ? 'Hide other chefs’ dishes' : 'Suggest another chef’s dish'} onPress={() => setSuggesting(!suggesting)} />}
          {suggesting && <StaffAlternative r={r} onDone={(d) => { setData(d); setSuggesting(false); }} />}
          {r.can.close && <TextAction label="Close request (reason shared with both sides)" button="Close request" variant="danger" min={3} busy={busy} onSend={(reason) => act(() => api.post<RequestDetail>(`/admin/chef-requests/${r.id}/close`, { reason }))} />}
        </Card>
      )}
      {staff && <Button variant="ghost" title="Refresh" onPress={() => void reload()} />}
    </ScrollView>
  );
}
