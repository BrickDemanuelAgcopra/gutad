'use client';
import { Card } from '@/components/ui';
import { InventoryWorkspace } from '@/components/inventory';
import { useMerchant } from '../context';

export default function InventoryPage() {
  const { loc, org } = useMerchant();
  if (!loc || !org) return null;
  if (!loc.kitchenId) return <Card title="Inventory"><p className="text-sm text-ink-500">Link this location to a production kitchen (Kitchen → Production kitchen) to track stock, lots and suppliers.</p></Card>;
  return <div className="space-y-4"><h1 className="text-2xl font-bold">Inventory</h1><InventoryWorkspace kitchenId={loc.kitchenId} organizationId={org.id} /></div>;
}
