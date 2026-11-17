'use client';
import Link from 'next/link';
import { useApi } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';
import { EarningsView, type Earnings } from '@/components/chef-ops';

export default function ChefEarningsPage() {
  const { data, error } = useApi<Earnings>('/chef/earnings');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2"><h1 className="text-2xl font-bold">Earnings</h1><Link href="/merchant/finance" className="text-sm underline">Weekly statements, payouts and disputes →</Link></div>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : <EarningsView e={data} />}
    </div>
  );
}
