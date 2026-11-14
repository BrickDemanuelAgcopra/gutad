'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { Alert, Button, Card, Input, Spinner } from '@/components/ui';

/** Landing page for the password-reset email (`account.recovery`). Works signed out. */
function Recover() {
  const sp = useSearchParams();
  const token = sp.get('token') || '';
  const [f, setF] = useState({ password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;
  const ok = f.password.length >= 8 && f.password === f.confirm;

  if (!token) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert>This reset link is incomplete. Request a new one from the sign-in page.</Alert>
        <Link className="text-sm underline" href="/account">Go to sign in</Link>
      </div>
    );
  }
  if (done) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert tone="info">Your password has been changed. Sign in with your new password.</Alert>
        <Link className="text-sm underline" href="/account">Go to sign in</Link>
      </div>
    );
  }
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/recover/complete', { token, password: f.password });
      setDone(true);
    } catch (e) {
      setError((e as Error).message || 'This link is invalid or has expired. Request a new one.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md">
      <Card title="Choose a new password">
        <div className="space-y-3">
          {error && <Alert>{error} <Link className="underline" href="/account">Request a new link</Link></Alert>}
          <Input label="New password (at least 8 characters)" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          {mismatch && <p className="text-sm text-red-600">The passwords don’t match.</p>}
          <Button className="w-full" disabled={!ok || busy} onClick={submit}>{busy ? 'Saving…' : 'Change password'}</Button>
        </div>
      </Card>
    </div>
  );
}

export default function RecoverPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Recover />
    </Suspense>
  );
}
