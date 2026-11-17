'use client';
import { useParams } from 'next/navigation';
import { RequestView } from '@/components/chef-requests';

export default function AdminChefRequestPage() {
  const { id } = useParams<{ id: string }>();
  return <RequestView id={id} backHref="/admin/chefs/requests" backLabel="Special requests" />;
}
