import { notFound } from 'next/navigation';
import { serverGet } from '@/lib/server';
import { RestaurantView, type LocationPage } from '@/components/restaurant-view';

export const revalidate = 30;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const loc = await serverGet<LocationPage>(`/public/locations/${slug}`);
  return { title: loc ? `${loc.name} — order, reserve, experiences` : 'Restaurant', description: loc?.description || undefined };
}

export default async function RestaurantPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const loc = await serverGet<LocationPage>(`/public/locations/${slug}`);
  if (!loc) notFound();
  return <RestaurantView loc={loc} channel="MARKETPLACE" src={sp.src || null} initialTab={sp.tab} initialBrand={sp.brand} />;
}
