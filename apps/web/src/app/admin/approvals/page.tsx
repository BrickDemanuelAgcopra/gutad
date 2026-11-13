'use client';
import { useState } from 'react';
import { APPROVAL_KINDS } from '@gutad/shared';
import { Select, Tabs } from '@/components/ui';
import { ApprovalsTable, SectionTitle } from '@/components/admin-ui';

export default function AdminApprovals() {
  const [tab, setTab] = useState('PENDING');
  const [kind, setKind] = useState('');
  const q = tab === 'MINE' ? `?mine=true${kind ? `&kind=${kind}` : ''}` : `?status=${tab}${kind ? `&kind=${kind}` : ''}`;
  return (
    <div className="space-y-4">
      <SectionTitle title="Approvals" hint="Refunds over limits, bank-account changes, sensitive settings, supplier purchases, price changes and payout releases. The requester can never approve their own request." action={<Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{Object.entries(APPROVAL_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>} />
      <Tabs tabs={[{ id: 'PENDING', label: 'Waiting' }, { id: 'MINE', label: 'My requests' }, { id: 'EXECUTED', label: 'Approved' }, { id: 'REJECTED', label: 'Rejected' }, { id: 'FAILED', label: 'Failed' }, { id: 'EXPIRED', label: 'Expired' }]} active={tab} onChange={setTab} />
      <ApprovalsTable query={q} empty={tab === 'PENDING' ? 'Nothing is waiting for a decision.' : 'No requests here.'} />
    </div>
  );
}
