import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="mt-2 text-ink-500">The restaurant, order or page you are looking for does not exist.</p>
      <Link href="/" className="mt-6 inline-block rounded-lg bg-brand-500 px-4 py-2 text-white">Back home</Link>
    </div>
  );
}
