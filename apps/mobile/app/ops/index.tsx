import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ADMIN_GROUPS, modulesFor, STAFF_ROLE_LABELS, type StaffRole } from '@gutad/shared';
import { useApi, useSession } from '@/hooks';
import { C, Card, H1, Muted, s } from '@/ui';
import { AccessBanner } from '@/ops';

/** Mobile Ops workspace home: the same module registry as web `/admin`, filtered by permission. */
export default function OpsHome() {
  const router = useRouter();
  const { user, ready, isStaff, can } = useSession();
  const { data: sum } = useApi<{ pending: number; mine: number }>(isStaff && can('approvals.decide') ? '/approvals/summary' : null, { poll: 30000 });
  if (!ready) return null;
  if (!user || !isStaff) return <View style={[s.screen, s.pad]}><Card title="Gutad Ops"><Muted>For Gutad staff only.</Muted></Card></View>;
  const mods = modulesFor(user.permissions || []).filter((m) => m.mobile && m.mobile !== '/ops');
  const roles = user.accessRoles?.length ? user.accessRoles.map((r) => r.name) : user.roles.filter((r) => r in STAFF_ROLE_LABELS).map((r) => STAFF_ROLE_LABELS[r as StaffRole]);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <H1>Gutad Ops</H1>
      <Muted>{roles.join(' · ')}</Muted>
      <View style={{ height: 10 }} />
      <AccessBanner />
      {!mods.length && <Card><Muted>No modules available yet. Ask an administrator for access.</Muted></Card>}
      {ADMIN_GROUPS.map((g) => {
        const items = mods.filter((m) => m.group === g);
        if (!items.length) return null;
        return (
          <View key={g} style={{ marginBottom: 12 }}>
            <Text style={{ color: C.ink5, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 }}>{g}</Text>
            {items.map((m) => (
              <Pressable key={m.key} onPress={() => router.push(m.mobile as never)} style={({ pressed }) => [{ backgroundColor: C.white, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.ink1, opacity: pressed ? 0.85 : 1 }]}>
                <View style={s.row}><Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>{m.label}</Text>{m.key === 'approvals' && !!sum?.pending && <Text style={{ backgroundColor: C.brand, color: C.white, borderRadius: 999, paddingHorizontal: 8, fontWeight: '700', overflow: 'hidden' }}>{sum.pending}</Text>}</View>
                <Muted>{m.description}</Muted>
              </Pressable>
            ))}
          </View>
        );
      })}
      <Pressable onPress={() => router.push('/ops/my-access')} style={({ pressed }) => [{ backgroundColor: C.white, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.ink1, opacity: pressed ? 0.85 : 1 }]}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>My access</Text>
        <Muted>Your roles, request more access and follow your requests</Muted>
      </Pressable>
      <Muted>Bulk editors (plans, menus, settings) are on the web console at gutad.io/admin.</Muted>
    </ScrollView>
  );
}
