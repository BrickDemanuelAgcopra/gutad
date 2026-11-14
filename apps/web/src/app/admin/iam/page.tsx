'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useApi, useSession } from '@/lib/hooks';
import { Spinner, Stat, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { StepUpProvider } from '@/components/iam/common';
import { UsersTab } from '@/components/iam/users';
import { RolesTab } from '@/components/iam/roles';
import { MatrixTab } from '@/components/iam/matrix';
import { RequestsTab } from '@/components/iam/requests';
import { ReviewsTab } from '@/components/iam/reviews';
import { SessionsTab } from '@/components/iam/sessions';
import { ServiceAccountsTab } from '@/components/iam/service-accounts';
import { AlertsTab } from '@/components/iam/alerts';
import { PolicyTab } from '@/components/iam/policy';

interface Overview { users: number; byStatus: Record<string, number>; invited: number; inactive: number; withoutMfa: number; temporary: number; roles: number; customRoles: number; superadmins: number; pendingRequests: number; openReviews: number; unacknowledgedAlerts: number; keysExpiring: number }

function Iam() {
  const { can } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const { data: ov, reload } = useApi<Overview>('/admin/iam/overview');
  const tabs = [
    { id: 'users', label: 'Users' },
    { id: 'roles', label: 'Roles' },
    { id: 'matrix', label: 'Permission matrix' },
    { id: 'requests', label: `Requests${ov?.pendingRequests ? ` (${ov.pendingRequests})` : ''}` },
    { id: 'reviews', label: 'Access reviews' },
    { id: 'sessions', label: 'Sessions & sign-ins' },
    ...(can('integrations.manage') ? [{ id: 'service', label: 'Service accounts & API keys' }] : []),
    { id: 'alerts', label: `Alerts${ov?.unacknowledgedAlerts ? ` (${ov.unacknowledgedAlerts})` : ''}` },
    { id: 'policy', label: 'Policy' },
  ];
  const want = sp.get('tab') || 'users';
  const tab = tabs.some((t) => t.id === want) ? want : 'users';
  const setTab = (id: string) => router.replace(`${path}?tab=${id}`, { scroll: false });
  const changed = () => { void reload(); };
  const active = ov ? ov.byStatus.ACTIVE || 0 : 0;
  return (
    <div className="space-y-4">
      <SectionTitle title="Users, roles & permissions" hint="Staff directory, roles and the permission matrix, temporary access, requests and reviews, sessions, API keys and security alerts." />
      {ov && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Staff" value={ov.users} hint={`${active} active · ${ov.invited} invited · ${ov.inactive} inactive`} />
          <Stat label="Without MFA" value={ov.withoutMfa} hint={`${ov.superadmins} superadmin(s) · ${ov.temporary} with temporary roles`} />
          <Stat label="Roles" value={ov.roles} hint={`${ov.customRoles} custom`} />
          <Stat label="Needs attention" value={ov.pendingRequests + ov.openReviews + ov.unacknowledgedAlerts} hint={`${ov.pendingRequests} requests · ${ov.openReviews} reviews · ${ov.unacknowledgedAlerts} alerts${ov.keysExpiring ? ` · ${ov.keysExpiring} keys expiring` : ''}`} />
        </div>
      )}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'users' && <UsersTab onChange={changed} />}
      {tab === 'roles' && <RolesTab onChange={changed} />}
      {tab === 'matrix' && <MatrixTab onChange={changed} />}
      {tab === 'requests' && <RequestsTab onChange={changed} />}
      {tab === 'reviews' && <ReviewsTab onChange={changed} />}
      {tab === 'sessions' && <SessionsTab />}
      {tab === 'service' && <ServiceAccountsTab />}
      {tab === 'alerts' && <AlertsTab onChange={changed} />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
}

export default function IamPage() {
  return (
    <StepUpProvider>
      <Suspense fallback={<Spinner />}><Iam /></Suspense>
    </StepUpProvider>
  );
}
