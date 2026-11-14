'use client';
import Link from 'next/link';
import { useApi } from '@/lib/hooks';
import { Badge, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface B { id: string; name: string; organizationName: string; ownershipType: string; ownerName: string | null; rightsStatus: string; contractEnd: string | null; authorizedChannels: string[]; royaltyBps: number; royaltyRules: unknown[]; kitchens: { name: string; isActive: boolean }[]; blockedReason: string | null }

export default function Brands() {
  const { data } = useApi<B[]>('/admin/brands');
  return (
    <div className="space-y-4">
      <SectionTitle title="Brands & partners" hint="Company-owned, licensed, independent and creator brands: who owns them, where and through which channels they may be sold, royalties, reviews and statements." />
      <Table rows={data || []} empty="No brands." cols={[
        { key: 'n', label: 'Brand', render: (b) => <Link className="underline" href={`/admin/brands/${b.id}`}>{b.name}<span className="block text-xs text-ink-500 no-underline">{b.organizationName}</span></Link> },
        { key: 'o', label: 'Ownership', render: (b) => <span className="text-xs">{b.ownershipType.toLowerCase().replace('_', ' ')}{b.ownerName ? ` · ${b.ownerName}` : ''}</span> },
        { key: 'r', label: 'Rights', render: (b) => <span><Badge tone={b.blockedReason ? 'bad' : 'good'}>{b.blockedReason || 'selling'}</Badge>{b.contractEnd && <span className="block text-xs text-ink-500">ends {new Date(b.contractEnd).toLocaleDateString()}</span>}</span> },
        { key: 'c', label: 'Channels', render: (b) => <span className="text-xs">{b.authorizedChannels.length ? b.authorizedChannels.join(', ').toLowerCase() : 'all'}</span> },
        { key: 'k', label: 'Kitchens', render: (b) => <span className="text-xs">{b.kitchens.map((k) => k.name + (k.isActive ? '' : ' (off)')).join(', ') || '—'}</span> },
        { key: 'y', label: 'Royalty', render: (b) => <span className="text-xs">{b.royaltyRules.length ? `${b.royaltyRules.length} rule(s)` : `${b.royaltyBps / 100}%`}</span> },
      ]} />
    </div>
  );
}
