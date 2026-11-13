'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';
import { adoptTokens } from '@/components/admin-ui';

interface Sess { id: string; amr: string[]; client: string | null; userAgent: string | null; ip: string | null; lastSeenAt: string; createdAt: string; current: boolean }

/** Account → Security: two-factor authentication and signed-in devices. */
export function AccountSecurity() {
  const { user } = useSession();
  const { data: sessions, reload } = useApi<Sess[]>('/auth/sessions');
  const { data: me, reload: reloadMe } = useApi<{ mfaEnabledAt: string | null; mfaRecoveryCodesLeft: number }>('/auth/me');
  const { run, error } = useAction();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const on = !!me?.mfaEnabledAt;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Two-factor authentication">
        {error && <Alert>{error}</Alert>}
        {user?.mfaSetupRequired && <Alert tone="info">Your role requires two-factor authentication.</Alert>}
        {codes && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><b>Save these recovery codes.</b> Each works once if you lose your phone.<div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{codes.map((c) => <span key={c}>{c}</span>)}</div></div>}
        {on ? (
          <div className="space-y-2 text-sm">
            <div><Badge tone="good">On</Badge> since {when(me!.mfaEnabledAt)} · {me!.mfaRecoveryCodesLeft} recovery codes left</div>
            <Input label="Code from your app to turn it off" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button variant="secondary" onClick={() => run(async () => { await api.post('/auth/mfa/disable', { code }); setCode(''); reloadMe(); })}>Turn off</Button>
          </div>
        ) : setup ? (
          <div className="space-y-2 text-sm">
            <p>Add this key to an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.</p>
            <div className="rounded bg-ink-50 p-2 font-mono text-xs break-all">{setup.secret}</div>
            <a className="text-xs underline" href={setup.otpauthUrl}>Open in authenticator app</a>
            <Input label="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button onClick={() => run(async () => { const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }); adoptTokens(r); setCodes(r.recoveryCodes); setSetup(null); setCode(''); reloadMe(); })}>Turn on</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm"><p className="text-ink-500">Protect your account with a code from your phone at every sign-in.</p><Button onClick={() => run(async () => setSetup(await api.post('/auth/mfa/setup', {})))}>Set up</Button></div>
        )}
      </Card>
      <Card title="Signed-in devices" action={sessions && sessions.length > 1 ? <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post('/auth/sessions/revoke-others', {}); reload(); })}>Sign out other devices</Button> : null}>
        <ul className="space-y-2 text-sm">{(sessions || []).map((s) => <li key={s.id} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2"><span><span className="font-medium">{s.client || (s.userAgent?.includes('Mobile') ? 'Phone' : 'Browser')}</span>{s.current && <Badge tone="good">this device</Badge>}<span className="block text-xs text-ink-500">{s.amr.includes('mfa') ? 'with 2FA · ' : s.amr.includes('sso') ? 'SSO · ' : ''}last active {when(s.lastSeenAt)}{s.ip ? ` · ${s.ip}` : ''}</span></span>{!s.current && <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/auth/sessions/${s.id}`); reload(); })}>Sign out</button>}</li>)}</ul>
      </Card>
    </div>
  );
}
