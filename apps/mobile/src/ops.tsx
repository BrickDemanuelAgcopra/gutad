import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { GutadApiError, merchantPageAllowed, type AuthResponse } from '@gutad/shared';
import { api, money, session, when } from './api';
import { useAction, useSession } from './hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, tone } from './ui';

/** Calls that return fresh tokens (MFA, emergency and support access) update the stored session. */
export async function adoptTokens(res: unknown) {
  const r = res as Partial<AuthResponse>;
  if (r && r.accessToken && r.refreshToken && r.user) await session.set(r as AuthResponse);
}

/** Red/amber banner while emergency elevation or support access is active. */
export function AccessBanner() {
  const { user } = useSession();
  const { run } = useAction();
  if (!user) return null;
  const el = user.elevated && new Date(user.elevated.until) > new Date() ? user.elevated : null;
  const sup = user.supportAccess && new Date(user.supportAccess.until) > new Date() ? user.supportAccess : null;
  return (
    <>
      {user.mfaSetupRequired && <View style={{ backgroundColor: '#e0f2fe', borderRadius: 12, padding: 12, marginBottom: 10 }}><Text style={{ color: '#075985' }}>Your role requires two-factor authentication. Set it up under Account → Security to open the console.</Text></View>}
      {el && <View style={{ backgroundColor: '#fee2e2', borderRadius: 12, padding: 12, marginBottom: 10 }}><Text style={{ color: '#991b1b', fontWeight: '600' }}>🚨 Emergency access: {el.roles.join(', ')} until {when(el.until)}</Text><Button title="End now" variant="danger" onPress={() => run(async () => adoptTokens(await api.post(`/access-grants/${el.grantId}/end`, {})))} /></View>}
      {sup && <View style={{ backgroundColor: '#fef3c7', borderRadius: 12, padding: 12, marginBottom: 10 }}><Text style={{ color: '#92400e' }}>🛟 Support access ({sup.readOnly ? 'read-only' : 'changes allowed'}) until {when(sup.until)}</Text><Button title="End session" variant="secondary" onPress={() => run(async () => adoptTokens(await api.post(`/access-grants/${sup.grantId}/end`, {})))} /></View>}
    </>
  );
}

export interface Approval { id: string; kind: string; status: string; summary: string; amountCents: number | null; reason: string; requestedById: string; requestedByEmail: string | null; createdAt: string; canDecide: boolean; decisionNote: string | null }

/** One approval with inline approve / reject (reject needs a note). */
export function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const { user } = useSession();
  const { run, error, busy } = useAction();
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <Pressable onPress={() => setOpen(!open)}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Badge text={a.kind.replace(/_/g, ' ')} /><Badge text={a.status} tone={tone(a.status === 'EXECUTED' ? 'COMPLETED' : a.status)} />{a.amountCents ? <Text style={{ fontWeight: '700' }}>{money(a.amountCents)}</Text> : null}</View>
        <Text style={{ marginTop: 6, color: C.ink, fontSize: 15 }}>{a.summary}</Text>
        <Muted>{a.requestedById === user?.id ? 'You' : a.requestedByEmail} · {when(a.createdAt)}</Muted>
        <Text style={{ color: C.ink7, marginTop: 4, fontStyle: 'italic' }}>“{a.reason}”</Text>
      </Pressable>
      {a.decisionNote && <Muted>Decision: {a.decisionNote}</Muted>}
      {a.canDecide && (open ? (
        <View style={{ marginTop: 8 }}>
          <Input label="Note (required to reject)" value={note} onChangeText={setNote} />
          <ErrorText msg={error} />
          <Button title="Approve" disabled={busy} onPress={() => run(async () => { await api.post(`/approvals/${a.id}/approve`, { note: note || undefined }); onDone(); })} />
          <Button title="Reject" variant="danger" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/approvals/${a.id}/reject`, { note }); onDone(); })} />
          <Muted>You can&apos;t approve your own requests. The change applies after the final approval.</Muted>
        </View>
      ) : <Button title="Review" onPress={() => setOpen(true)} />)}
      {a.status === 'PENDING' && a.requestedById === user?.id && <Button title="Withdraw" variant="ghost" onPress={() => run(async () => { await api.post(`/approvals/${a.id}/cancel`, {}); onDone(); })} />}
    </Card>
  );
}

/** Pill selector used across Ops screens. */
export function Pills<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      {options.map((o) => <Pressable key={o.id} onPress={() => onChange(o.id)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: value === o.id ? C.brand : C.white, borderWidth: 1, borderColor: value === o.id ? C.brand : C.ink1 }}><Text style={{ color: value === o.id ? C.white : C.ink7, fontWeight: '600', fontSize: 13 }}>{o.label}</Text></Pressable>)}
    </View>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, backgroundColor: C.white, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.ink1 }}>
      <Text style={{ color: C.ink5, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: C.ink, fontSize: 22, fontWeight: '700' }}>{value}</Text>
      {hint ? <Text style={{ color: C.ink5, fontSize: 11 }}>{hint}</Text> : null}
    </View>
  );
}

/** Restricted workspaces: merchant screens open only for member roles that use them (owners and managers see all). */
export function WorkspaceGate({ page, children }: { page: string; children: React.ReactNode }) {
  const { user, ready, memberRoles } = useSession();
  if (!ready) return null;
  if (user && !merchantPageAllowed(page, memberRoles)) {
    return <View style={{ flex: 1, padding: 16, backgroundColor: C.bg }}><Card title="Not part of your role"><Muted>Ask your manager if you need this screen.</Muted></Card></View>;
  }
  return <>{children}</>;
}

export type StepUpProof = { code: string } | { password: string };
type StepUpAsk = { method: 'totp' | 'password'; message: string; retry: (p: StepUpProof) => Promise<unknown> };

/**
 * Critical IAM changes answer 403 STEP_UP_REQUIRED (method `totp` or `password`). `guard(fn)` runs `fn()` and,
 * on that answer, opens a cross-platform prompt (Alert.prompt is iOS-only) that retries `fn(proof)`.
 * Render `modal` once in the screen.
 */
export function useStepUp() {
  const [ask, setAsk] = useState<StepUpAsk | null>(null);
  const guard = async <T,>(fn: (proof?: StepUpProof) => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const b = e instanceof GutadApiError && e.status === 403 ? (e.body as unknown as { code?: string; method?: string } | null) : null;
      if (b?.code !== 'STEP_UP_REQUIRED') throw e;
      setAsk({ method: b.method === 'password' ? 'password' : 'totp', message: e instanceof Error ? e.message : 'Confirm this change', retry: fn });
      return undefined;
    }
  };
  return { guard, modal: <StepUpModal ask={ask} onClose={() => setAsk(null)} /> };
}

function StepUpModal({ ask, onClose }: { ask: StepUpAsk | null; onClose: () => void }) {
  const [value, setValue] = useState('');
  const { run, error, busy } = useAction();
  const close = () => { setValue(''); onClose(); };
  return (
    <Modal visible={!!ask} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }}>
        <Card title="Confirm it's you">
          <Muted>{ask?.message}</Muted>
          <Input label={ask?.method === 'password' ? 'Password' : 'Authenticator code'} value={value} onChangeText={setValue} secureTextEntry={ask?.method === 'password'} keyboardType={ask?.method === 'password' ? 'default' : 'number-pad'} autoFocus />
          <ErrorText msg={error} />
          <Button title="Confirm" disabled={busy || !value.trim()} onPress={() => run(async () => { if (!ask) return; await ask.retry(ask.method === 'password' ? { password: value } : { code: value.trim() }); close(); })} />
          <Button title="Cancel" variant="ghost" onPress={close} />
        </Card>
      </View>
    </Modal>
  );
}
