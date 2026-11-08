import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server';
import { RestaurantView, type LocationPage } from '@/components/restaurant-view';

export const revalidate = 30;

/** Branded direct-ordering page (merchant site / QR / order link). Channel attribution comes from ?src= and ?ch=. */
export default async function BrandedOrderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const loc = await serverGet<LocationPage>(`/public/locations/${slug}`);
  if (!loc) notFound();
  const channel = sp.ch === 'QR' ? 'QR' : sp.ch === 'WIDGET' ? 'WIDGET' : 'DIRECT';
  return <RestaurantView loc={loc} channel={channel} src={sp.src || null} branded initialTab="order" />;
}
