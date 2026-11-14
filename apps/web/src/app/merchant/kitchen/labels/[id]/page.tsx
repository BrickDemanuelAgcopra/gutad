'use client';
import { useParams } from 'next/navigation';
import { HANDLING_LABELS, type HandlingFlag } from '@gutad/shared';
import { useApi } from '@/lib/hooks';
import { Button } from '@/components/ui';
import { PrintButton } from '@/components/capacity-printers';

interface Labels { locationName: string; orderNumber: string; customer: string | null; fulfillmentType: string; tableNumber: string | null; promiseAt: string | null; shelfSlot: string | null; bags: { n: number; of: number; code: string; handling: string[] }[]; allergyNotes: string[]; items: { name: string; quantity: number; handling: string[] }[] }

/** 14.2 printable bag labels (one per bag). The pickup code is never printed. */
export default function BagLabels() {
  const { id } = useParams<{ id: string }>();
  const { data } = useApi<Labels>(`/packing/${id}/labels`);
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden"><Button onClick={() => window.print()}>Print {data.bags.length} label{data.bags.length > 1 ? 's' : ''}</Button><PrintButton path={`/packing/${id}/print-labels`} label="Send to label printer" size="md" /></div>
      {data.bags.map((b) => (
        <div key={b.n} className="w-[4in] break-after-page rounded border-2 border-black bg-white p-3 font-mono text-black">
          <div className="flex justify-between text-xs"><span>{data.locationName}</span><span>{data.fulfillmentType}{data.tableNumber ? ` · TABLE ${data.tableNumber}` : ''}</span></div>
          <div className="mt-1 text-3xl font-bold">{data.orderNumber}</div>
          <div className="text-lg">{data.customer || ''}</div>
          <div className="mt-1 text-xl font-bold">BAG {b.n} OF {b.of}</div>
          <div className="mt-1 flex flex-wrap gap-1">{b.handling.map((h) => <span key={h} className="border-2 border-black px-1 text-sm font-bold">{(HANDLING_LABELS[h as HandlingFlag] || h).toUpperCase()}</span>)}</div>
          {b.n === 1 && <ul className="mt-2 text-xs">{data.items.map((i, k) => <li key={k}>{i.quantity}× {i.name}</li>)}</ul>}
          {data.allergyNotes.length > 0 && <div className="mt-2 border-t-2 border-black pt-1 text-xs font-bold">ALLERGY: {data.allergyNotes.join('; ')}</div>}
          <div className="mt-2 text-[10px]">{b.code}{data.promiseAt ? ` · due ${new Date(data.promiseAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
        </div>
      ))}
    </div>
  );
}
