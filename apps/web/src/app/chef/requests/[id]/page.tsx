'use client';
import { useParams } from 'next/navigation';
import { RequestView } from '@/components/chef-requests';

export default function ChefRequestPage() {
  const { id } = useParams<{ id: string }>();
  return <RequestView id={id} backHref="/chef/requests" backLabel="Special requests" />;
}
