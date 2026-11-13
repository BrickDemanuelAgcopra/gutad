import { ScrollView, Text, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { money } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Button, Card, Muted, s } from '@/ui';

export default function Account() {
  const { user, ready, isMerchant, isDriver, isStaff, memberRoles, logout } = useSession();
  const mgr = memberRoles.some((r) => r === 'MERCHANT_OWNER' || r === 'MERCHANT_MANAGER');
  const has = (...r: string[]) => mgr || memberRoles.some((x) => r.includes(x));
  const router = useRouter();
  const { data: loyalty } = useApi<{ points: number; valueCents: number; credits: { availableCents: number }; membership: { plan: { name: string } } | null }>(user ? '/me/loyalty' : null, { deps: [user?.id] });
  if (!ready) return null;
  if (!user) return <View style={[s.screen, s.pad]}><Card title="Welcome to Gutad"><Muted>Sign in to order, reserve and earn rewards.</Muted><Button title="Sign in / create account" onPress={() => router.push('/login')} /></Card></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title={user.name || user.email}>
        <Muted>{user.email}</Muted>
        {loyalty && <Text style={{ marginTop: 8 }}>{loyalty.points} points (≈{money(loyalty.valueCents)}) · credits {money(loyalty.credits.availableCents)}{loyalty.membership ? ` · ${loyalty.membership.plan.name} member` : ''}</Text>}
        <Link href="/security" asChild><Button title="Security (2FA & devices)" variant="secondary" onPress={() => undefined} /></Link>
        <Button title="Sign out" variant="secondary" onPress={logout} />
      </Card>
      {isStaff && <Card title="Gutad Ops"><Muted>Approvals, staff & access, audit and the organization structure.</Muted><Link href="/ops" asChild><Button title="Open Ops workspace" onPress={() => undefined} /></Link></Card>}
      {isMerchant && <Card title="Merchant tools"><Muted>Only the screens your role uses.</Muted>{has('MERCHANT_STAFF', 'PACKER') && <Link href="/merchant" asChild><Button title="Open merchant tablet" onPress={() => undefined} /></Link>}{has('MERCHANT_STAFF', 'HOST') && <Link href="/merchant/host" asChild><Button title="Host stand" variant="secondary" onPress={() => undefined} /></Link>}{has('KITCHEN', 'PACKER') && <Link href="/merchant/kitchen" asChild><Button title="Kitchen screen" variant="secondary" onPress={() => undefined} /></Link>}</Card>}
      <Card title={isDriver ? 'Driver' : 'Drive with Gutad'}><Muted>{isDriver ? 'Go online, accept offers, navigate and hand off with proof.' : 'Apply to deliver for the Gutad fleet.'}</Muted><Link href="/driver" asChild><Button title={isDriver ? 'Open driver mode' : 'Apply to drive'} variant="secondary" onPress={() => undefined} /></Link></Card>
    </ScrollView>
  );
}
