'use client';
import Link from 'next/link';
import { useState } from 'react';
import { COURIER_DOC_LABELS, type CourierDocKind } from '@gutad/shared';
import { api } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Card, Spinner, Tabs } from '@/components/ui';
import { type Onboarding } from '@/components/courier/common';
import { OnboardingWizard } from '@/components/courier/onboarding';
import { Documents, FirstDeliveryGuide, ShiftsCard, StatusCard, type CourierStatus, type Standing } from '@/components/courier/work';
import { JobCard, OfferCard, type Job, type Offer } from '@/components/courier/trips';
import { EarningsSection, FeedbackSection } from '@/components/courier/money';

/** Web console for Gutad-fleet couriers (the mobile app is the primary surface): sign-up, then work. */
export default function DriverPage() {
  const { user, ready } = useSession();
  const { data: ob, error, reload } = useApi<Onboarding>(user ? '/driver/onboarding' : null, { deps: [user?.id] });
  if (!ready) return <Spinner />;
  if (!user) return <Alert tone="info">Please <Link className="underline" href="/account">sign in</Link> to deliver with Gutad.</Alert>;
  if (!ob) return error ? <Alert>{error}</Alert> : <Spinner />;
  if (!ob.driver || ob.driver.applicationStatus !== 'APPROVED') return <OnboardingWizard ob={ob} reload={reload} />;
  return <CourierConsole />;
}

function CourierConsole() {
  const { data: status, reload: reloadStatus } = useApi<CourierStatus>('/driver/status', { poll: 15000 });
  const { data: standing, reload: reloadStanding } = useApi<Standing>('/driver/standing');
  const { data: offers, reload: reloadOffers } = useApi<Offer[]>('/driver/offers', { poll: 5000 });
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>('/driver/jobs', { poll: 5000 });
  const [tab, setTab] = useState('work');
  const refresh = async () => { await Promise.all([reloadStatus(), reloadStanding(), reloadOffers(), reloadJobs()]); };
  if (!status) return <Spinner />;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <StatusCard status={status} standing={standing} onChange={refresh} />
      {!status.firstDeliveryAt && <FirstDeliveryGuide />}
      {standing && standing.missingDocs.length > 0 && <Alert tone="info">Upload and get approved: {standing.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind] || d).join(', ')}.</Alert>}
      <Tabs tabs={[{ id: 'work', label: 'Deliveries' }, { id: 'earnings', label: 'Earnings' }, { id: 'feedback', label: 'Feedback' }, { id: 'account', label: 'Documents & shifts' }]} active={tab} onChange={setTab} />
      {tab === 'work' && (
        <>
          <Card title="Offers">
            {offers?.length ? <div className="space-y-2">{offers.map((o) => <OfferCard key={o.id} offer={o} onAnswer={async (accept) => { await api.post(`/driver/offers/${o.id}`, { accept }); await refresh(); }} />)}</div> : <p className="text-sm text-ink-500">{status.dispatchable ? 'No offers right now. Stay online; they’ll appear here.' : 'No offers right now.'}</p>}
          </Card>
          <Card title="Active deliveries">
            {jobs?.length ? jobs.map((j) => <JobCard key={j.id} job={j} onChange={refresh} />) : <p className="text-sm text-ink-500">No active deliveries.</p>}
          </Card>
        </>
      )}
      {tab === 'earnings' && <EarningsSection />}
      {tab === 'feedback' && <FeedbackSection />}
      {tab === 'account' && (
        <>
          <Documents />
          <ShiftsCard onCheckedIn={() => void refresh()} />
        </>
      )}
    </div>
  );
}
