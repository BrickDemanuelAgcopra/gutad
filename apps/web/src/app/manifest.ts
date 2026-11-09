import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Gutad — order, reserve, and experience restaurants',
    short_name: 'Gutad',
    description: 'Pickup, delivery, reservations, experiences and private events from one restaurant page.',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf7f3',
    theme_color: '#f45d0a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
