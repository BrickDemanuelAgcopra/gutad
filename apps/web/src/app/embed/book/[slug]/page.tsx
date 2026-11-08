import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server';
import { ReserveTab, type LocationPage } from '@/components/restaurant-view';

/** Embeddable booking widget: <iframe src="https://gutad.io/embed/book/<slug>?src=<publication>"> */
export default async function EmbedBook({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const loc = await serverGet<LocationPage>(`/public/locations/${slug}`);
  if (!loc) notFound();
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Reserve at {loc.name}</h2>
      <ReserveTab loc={loc} channel="WIDGET" compact />
      <p className="mt-3 text-center text-[10px] text-ink-300">Powered by Gutad</p>
    </div>
  );
}
