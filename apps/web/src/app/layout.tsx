import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/header';

export const metadata: Metadata = {
  title: { default: 'Gutad — order, reserve, and experience restaurants', template: '%s · Gutad' },
  description: 'Pickup, delivery, reservations, experiences and private events from one restaurant page. gutad.io',
  metadataBase: new URL(process.env.PUBLIC_WEB_URL || 'https://gutad.io'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mt-16 border-t border-ink-100 py-8 text-center text-xs text-ink-500">© {new Date().getFullYear()} Gutad · gutad.io · <a className="underline" href="/for-restaurants">For restaurants</a> · <a className="underline" href="/driver">Drive with Gutad</a></footer>
      </body>
    </html>
  );
}
