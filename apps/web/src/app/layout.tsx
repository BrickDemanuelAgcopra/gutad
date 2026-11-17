import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Header } from '@/components/header';
import { LogoMark } from '@/components/logo';

export const metadata: Metadata = {
  title: { default: 'Gutad — order, reserve, and experience restaurants', template: '%s · Gutad' },
  description: 'Pickup, delivery, reservations, experiences and private events from one restaurant page. gutad.io',
  metadataBase: new URL(process.env.PUBLIC_WEB_URL || 'https://gutad.io'),
  applicationName: 'Gutad',
  appleWebApp: { title: 'Gutad', capable: true, statusBarStyle: 'default' },
  openGraph: { type: 'website', siteName: 'Gutad', url: '/' },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = { themeColor: '#f45d0a' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mt-16 border-t border-ink-100 py-8 text-center text-xs text-ink-500"><LogoMark className="mx-auto mb-3 h-7 w-7 opacity-90" />© {new Date().getFullYear()} Gutad · gutad.io · <a className="underline" href="/for-restaurants">For restaurants</a> · <a className="underline" href="/pricing">Pricing</a> · <a className="underline" href="/chefs/apply">Cook with Gutad</a> · <a className="underline" href="/driver">Drive with Gutad</a> · <a className="underline" href="/privacy">Privacy</a> · <a className="underline" href="/terms">Terms</a></footer>
      </body>
    </html>
  );
}
