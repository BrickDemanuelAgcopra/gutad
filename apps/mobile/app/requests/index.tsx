import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CHEF_REQUEST_OPEN, type ChefRequestSummary } from '@gutad/shared';
import { useApi, useSession } from '@/hooks';
import { Button, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { RequestRow } from '@/chef-requests';

/** My special requests to Gutad chefs: open first, then past ones. */
export default function MyRequests() {
  const router = useRouter();
  const { user, ready } = useSession();
  const { data, error } = useApi<ChefRequestSummary[]>(user ? '/chef-requests' : null, { deps: [user?.id], poll: 30000 });
  if (!ready) return null;
  if (!user) return <View style={[s.screen, s.pad]}><Card title="Special requests"><Muted>Sign in to see your requests to chefs.</Muted><Button title="Sign in / create account" onPress={() => router.push('/login')} /></Card></View>;
  if (!data) return error ? <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View> : <Loading />;
  const open = data.filter((r) => CHEF_REQUEST_OPEN.includes(r.status));
  const past = data.filter((r) => !CHEF_REQUEST_OPEN.includes(r.status));
  const go = (id: string) => router.push({ pathname: '/requests/[id]', params: { id } });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {!data.length && <Card><Muted>No requests yet. On a chef’s dish, tap “Request something special” to ask for a change.</Muted><Button variant="secondary" title="Browse chefs" onPress={() => router.push('/chefs')} /></Card>}
      {open.map((r) => <RequestRow key={r.id} r={r} onPress={() => go(r.id)} />)}
      {past.length > 0 && <View style={{ marginTop: 8, marginBottom: 6 }}><Muted>Past requests</Muted></View>}
      {past.map((r) => <RequestRow key={r.id} r={r} onPress={() => go(r.id)} />)}
    </ScrollView>
  );
}
