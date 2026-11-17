'use client';
import { useParams } from 'next/navigation';
import { useSession } from '@/lib/hooks';
import { Spinner } from '@/components/ui';
import { AuthForm } from '@/components/auth-form';
import { RequestView } from '@/components/chef-requests';

export default function CustomerRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { user, ready } = useSession();
  if (!ready) return <Spinner />;
  if (!user) return <AuthForm />;
  return <RequestView id={id} backHref="/account?tab=requests" backLabel="My requests" />;
}
