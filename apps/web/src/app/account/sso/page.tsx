'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { AuthResponse } from '@gutad/shared';
import { api, session } from '@/lib/api';
import { Alert, Spinner } from '@/components/ui';

/** OpenID Connect redirect target: trades the code for a Gutad session. */
function SsoCallback() {
  const sp = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const code = sp.get('code');
    const state = sp.get('state');
    if (sp.get('error')) { setError(sp.get('error_description') || sp.get('error')); return; }
    if (!code || !state) { setError('Missing sign-in response.'); return; }
    api.post<AuthResponse>('/auth/sso/callback', { code, state }).then((r) => { session.set(r); router.replace(r.user.permissions?.length ? '/admin' : '/account'); }).catch((e) => setError((e as Error).message));
  }, [sp, router]);
  if (error) return <div className="mx-auto max-w-md"><Alert>{error}</Alert><Link className="mt-3 inline-block text-sm underline" href="/account">Back to sign in</Link></div>;
  return <Spinner />;
}

export default function SsoPage() {
  return <Suspense fallback={<Spinner />}><SsoCallback /></Suspense>;
}
