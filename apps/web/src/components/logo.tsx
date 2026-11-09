import { useId } from 'react';

/** Gutad brand mark — a G with one clean cleaver slice (gutad: Cebuano for "to chop"). */
export function LogoMark({ className = 'h-8 w-8', title = 'Gutad' }: { className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg viewBox="0 0 512 512" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#e64f06" />
        </linearGradient>
        <mask id={`sl${id}`} maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640">
          <rect x="-64" y="-64" width="640" height="640" fill="#fff" />
          <rect x="69.45" y="308.97" width="140" height="18" fill="#000" transform="rotate(-58 139.45 317.97)" />
        </mask>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#bg${id})`} />
      <path d="M349.3 162.7 A132 132 0 1 0 388 256 H276" mask={`url(#sl${id})`} fill="none" stroke="#fff" strokeWidth="66" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark />
      <span className="text-xl font-extrabold tracking-tight text-ink-900">gutad</span>
    </span>
  );
}
