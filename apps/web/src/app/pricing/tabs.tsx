'use client';
import { useRouter } from 'next/navigation';
import { Tabs } from '@/components/ui';

export function PricingTabs({ lines, active }: { lines: { key: string; label: string }[]; active: string }) {
  const router = useRouter();
  return <Tabs tabs={lines.map((l) => ({ id: l.key, label: l.label }))} active={active} onChange={(id) => router.replace(`/pricing?line=${id}`, { scroll: false })} />;
}
