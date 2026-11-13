import Link from 'next/link';
import { MerchantAgreementText } from '@/components/merchant-agreement';

export const metadata = { title: 'Merchant Agreement', description: 'The terms independent restaurants accept to sell on Gutad.' };

export default function MerchantAgreementPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">Merchant Agreement</h1>
      <p className="mt-2 text-ink-500">For independent restaurants selling through Gutad. Restaurants accept it in the merchant portal during onboarding. <Link className="underline" href="/for-restaurants">List your restaurant</Link>.</p>
      <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-6 shadow-card"><MerchantAgreementText /></div>
    </div>
  );
}
