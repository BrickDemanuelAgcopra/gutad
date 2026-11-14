'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { AuthResponse } from '@gutad/shared';
import { api, session, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Spinner } from '@/components/ui';

type Peek = { valid: false } | { valid: true; email: string; name: string | null; expiresAt: string };

/** Staff invitation: set a name and password, then land in the admin console. Works signed out. */
function AcceptInvite() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get('token') || '';
  const { data: peek, error: peekError, loading } = useApi<Peek>(token ? `/auth/invite/${encodeURIComponent(token)}` : null);
  const [f, setF] = useState({ name: '', password: '', confirm: '' });
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (token && loading) return <Spinner />;
  if (!token || peekError || !peek || !peek.valid) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert>{peekError || 'This invitation link is invalid or has expired. Ask an administrator to resend it.'}</Alert>
        <Link className="text-sm underline" href="/account">Go to sign in</Link>
      </div>
    );
  }
  const name = nameTouched ? f.name : f.name || peek.name || '';
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;
  const ok = f.password.length >= 10 && f.password === f.confirm;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AuthResponse>('/auth/invite/accept', { token, password: f.password, name: name.trim() || undefined });
      session.set(r);
      router.replace('/admin');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md">
      <Card title="Join the Gutad team">
        <div className="space-y-3 text-sm">
          <p className="text-ink-500">You were invited as <b className="text-ink-900">{peek.email}</b>. Set your password to finish. This link expires {when(peek.expiresAt)}.</p>
          {error && <Alert>{error}</Alert>}
          <Input label="Your name" value={name} onChange={(e) => { setNameTouched(true); setF({ ...f, name: e.target.value }); }} autoComplete="name" />
          <Input label="Password (at least 10 characters)" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <Input label="Confirm password" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          {mismatch && <p className="text-xs text-red-700">The passwords do not match.</p>}
          {f.password.length > 0 && f.password.length < 10 && <p className="text-xs text-ink-500">{10 - f.password.length} more character(s).</p>}
          <Button className="w-full" disabled={!ok || busy} onClick={submit}>{busy ? 'Setting up…' : 'Set password and continue'}</Button>
          <p className="text-xs text-ink-500">Your role may require two-factor authentication; you will be asked to set it up before the console opens.</p>
        </div>
      </Card>
    </div>
  );
}

export default function InvitePage() {
  return <Suspense fallback={<Spinner />}><AcceptInvite /></Suspense>;
}
