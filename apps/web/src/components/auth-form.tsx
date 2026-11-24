'use client';
import { useState } from 'react';
import type { AuthResponse, MfaChallenge } from '@gutad/shared';
import { api, session } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input } from '@/components/ui';
import { SmsNotice } from '@/components/legal';

/** Sign in / create account / recover, with MFA and SSO. `audience="courier"` drops the customer-only bits: restaurant marketing opt-in and demo-account hints. */
export function AuthForm({ initialMode = 'login', title, audience = 'customer' }: { initialMode?: 'login' | 'register'; title?: string; audience?: 'customer' | 'courier' } = {}) {
  const customer = audience === 'customer';
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>(initialMode);
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '', marketingConsent: false });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { data: sso } = useApi<{ enabled: boolean; label: string }>('/auth/sso/config');
  const submit = async () => {
    setError(null);
    try {
      if (challenge) { session.set(await api.post<AuthResponse>('/auth/mfa/verify', { challengeToken: challenge, code })); return; }
      if (mode === 'recover') { await api.post('/auth/recover', { email: f.email }); setInfo('If that email exists, a reset link has been sent.'); return; }
      const r = await api.post<AuthResponse | MfaChallenge>(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: f.email, password: f.password } : f);
      if ('mfaRequired' in r) { setChallenge(r.challengeToken); return; }
      session.set(r);
    } catch (e) { setError((e as Error).message); }
  };
  const startSso = async () => {
    setError(null);
    try { window.location.href = (await api.post<{ url: string }>('/auth/sso/start', {})).url; } catch (e) { setError((e as Error).message); }
  };
  if (challenge) return (
    <div className="mx-auto max-w-md">
      <Card title="Two-factor authentication">
        <div className="space-y-2">
          <p className="text-sm text-ink-500">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          <Input label="Code" autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          {error && <Alert>{error}</Alert>}
          <Button className="w-full" onClick={submit}>Verify</Button>
          <button className="text-xs text-ink-500 underline" onClick={() => { setChallenge(null); setCode(''); }}>Start over</button>
        </div>
      </Card>
    </div>
  );
  return (
    <div className="mx-auto max-w-md">
      <Card title={title && mode !== 'recover' ? title : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Recover account'}>
        <div className="space-y-2">
          {mode === 'register' && <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
          <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          {mode !== 'recover' && <Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />}
          {mode === 'register' && <Input label="Phone (for SMS updates)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}
          {mode === 'register' && <SmsNotice />}
          {mode === 'register' && customer && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} /> Send me offers from restaurants I order from</label>}
          {error && <Alert>{error}</Alert>}
          {info && <Alert tone="info">{info}</Alert>}
          <Button className="w-full" onClick={submit}>{mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}</Button>
          {mode === 'login' && sso?.enabled && <Button className="w-full" variant="secondary" onClick={startSso}>{sso.label}</Button>}
          <div className="flex justify-between text-xs text-ink-500">
            <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="underline">{mode === 'login' ? 'Create an account' : 'Have an account? Sign in'}</button>
            <button onClick={() => setMode('recover')} className="underline">Forgot password</button>
          </div>
        </div>
      </Card>
      {customer && <p className="mt-4 text-center text-xs text-ink-500">Demo accounts: customer@demo.gutad.io / customer12345 · owner@demo.gutad.io / merchant12345</p>}
    </div>
  );
}
