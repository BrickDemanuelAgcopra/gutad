import { useId } from 'react';

/** Green "G" badge: marks menus prepared by Gutad's own culinary team at a Gutad food hall (Made at Gutad). */
export function GBadge({ className = 'h-5 w-5' }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg viewBox="0 0 512 512" className={`shrink-0 ${className}`} role="img" aria-label="Made at Gutad">
      <defs>
        <mask id={`gb${id}`} maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640">
          <rect x="-64" y="-64" width="640" height="640" fill="#fff" />
          <rect x="69.45" y="308.97" width="140" height="18" fill="#000" transform="rotate(-58 139.45 317.97)" />
        </mask>
      </defs>
      <circle cx="256" cy="256" r="256" fill="#059669" />
      <path d="M349.3 162.7 A132 132 0 1 0 388 256 H276" mask={`url(#gb${id})`} fill="none" stroke="#fff" strokeWidth="66" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Badge plus label, e.g. on cards and headers. */
export function MadeAtGutad({ className = '', tone = 'light' }: { className?: string; tone?: 'light' | 'dark' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] font-semibold ${tone === 'dark' ? 'bg-white/90 text-emerald-800' : 'bg-emerald-50 text-emerald-800'} ${className}`} title="Prepared by Gutad's culinary team at a Gutad food hall">
      <GBadge className="h-4 w-4" /> Made at Gutad
    </span>
  );
}
