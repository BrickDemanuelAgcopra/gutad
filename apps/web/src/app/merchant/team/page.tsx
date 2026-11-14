'use client';
import { TeamWorkspace } from '@/components/team';
import { useMerchant } from '../context';

export default function TeamPage() {
  const { loc, org } = useMerchant();
  if (!loc || !org) return null;
  const members = (org.members as unknown as { userId: string; email: string; role: string }[]).map((m) => ({ id: m.userId, email: m.email, role: m.role }));
  return <div className="space-y-4"><h1 className="text-2xl font-bold">Team & equipment</h1><TeamWorkspace locationId={loc.id} kitchenId={loc.kitchenId} organizationId={org.id} members={members} /></div>;
}
