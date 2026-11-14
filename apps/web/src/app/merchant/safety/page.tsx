'use client';
import { Card } from '@/components/ui';
import { SafetyWorkspace } from '@/components/safety';
import { useMerchant } from '../context';

export default function SafetyPage() {
  const { loc, org } = useMerchant();
  if (!loc || !org) return null;
  if (!loc.kitchenId) return <Card title="Food safety"><p className="text-sm text-ink-500">Link this location to a production kitchen to keep temperature logs, checklists and inspections here.</p></Card>;
  return <div className="space-y-4"><h1 className="text-2xl font-bold">Food safety</h1><SafetyWorkspace kitchenId={loc.kitchenId} organizationId={org.id} /></div>;
}
