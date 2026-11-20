'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Alert, Spinner } from '@/components/ui';

/** Landing page for the link in the verification email (`account.verify_email`). Works signed out. */
function Verify() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api.post<{ email: string }>('/auth/verify-email/link', { token })
      .then((r) => setState({ ok: true, text: `Thanks! ${r.email} is confirmed.` }))
      .catch((e) => setState({ ok: false, text: (e as Error).message || 'This link is invalid or has expired.' }));
  }, [token]);
  if (!token) return <div className="mx-auto max-w-md space-y-3"><Alert>This confirmation link is incomplete. Sign in to get a new one.</Alert><Link className="text-sm underline" href="/account">Go to your account</Link></div>;
  if (!state) return <Spinner />;
  return (
    <div className="mx-auto max-w-md space-y-3">
      <Alert tone={state.ok ? 'good' : 'bad'}>{state.text}</Alert>
      <Link className="text-sm underline" href="/account">{state.ok ? 'Go to your account' : 'Sign in to send a new code'}</Link>
    </div>
  );
}

export default function VerifyPage() {
  return <Suspense fallback={<Spinner />}><Verify /></Suspense>;
}
