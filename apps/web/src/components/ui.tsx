'use client';
import Link from 'next/link';
import { ReactNode, useState } from 'react';

export function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' }) {
  const v = { primary: 'bg-brand-500 hover:bg-brand-600 text-white shadow-sm', secondary: 'bg-white hover:bg-ink-50 text-ink-900 border border-ink-100', ghost: 'bg-transparent hover:bg-ink-50 text-ink-700', danger: 'bg-red-600 hover:bg-red-700 text-white' }[variant];
  const s = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-3 text-base' }[size];
  return (
    <button className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${v} ${s} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Card({ children, className = '', title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`rounded-2xl bg-white shadow-card border border-ink-100 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          {title && <h3 className="font-semibold text-ink-900">{title}</h3>}
          {action}
        </div>
      )}
      <div className="px-5 pb-5 pt-2">{children}</div>
    </div>
  );
}

export function Input({ label, className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>}
      <input className="w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" {...rest} />
    </label>
  );
}

export function Select({ label, className = '', children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>}
      <select className="w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-400" {...rest}>
        {children}
      </select>
    </label>
  );
}

export function Textarea({ label, className = '', ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>}
      <textarea className="w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-400" {...rest} />
    </label>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const t = { neutral: 'bg-ink-100 text-ink-700', good: 'bg-emerald-100 text-emerald-800', warn: 'bg-amber-100 text-amber-800', bad: 'bg-red-100 text-red-800', info: 'bg-sky-100 text-sky-800' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${t}`}>{children}</span>;
}

export function statusTone(s?: string): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (!s) return 'neutral';
  if (['COMPLETED', 'COLLECTED', 'DELIVERED', 'PAID', 'RECONCILED', 'CONFIRMED', 'SEATED', 'RESOLVED', 'LIVE', 'ACTIVE', 'SENT', 'CAPTURED', 'SETTLED', 'RELEASED'].includes(s)) return 'good';
  if (['SUBMITTED', 'HELD', 'REQUESTED', 'QUOTED', 'PENDING', 'OPEN', 'WAITING', 'NOTIFIED', 'ELIGIBLE', 'SUBMITTED'].includes(s)) return 'warn';
  if (['REJECTED', 'CANCELED', 'FAILED', 'NO_SHOW', 'EXPIRED', 'SUSPENDED', 'DISPUTED', 'BLOCKED', 'UNASSIGNED', 'ERROR'].includes(s)) return 'bad';
  if (['ACCEPTED', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP', 'AUTHORIZED', 'VERIFYING', 'IN_PROGRESS', 'QUEUED'].includes(s)) return 'info';
  return 'neutral';
}

export function Alert({ children, tone = 'bad' }: { children: ReactNode; tone?: 'bad' | 'good' | 'info' }) {
  const t = { bad: 'bg-red-50 text-red-800 border-red-100', good: 'bg-emerald-50 text-emerald-800 border-emerald-100', info: 'bg-sky-50 text-sky-800 border-sky-100' }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${t}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-ink-100 p-8 text-center text-sm text-ink-500">{children}</div>;
}

export function Spinner() {
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-100 border-t-brand-500" />;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-xl bg-ink-100 p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${active === t.id ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Table<T>({ rows, cols, empty = 'Nothing here yet.' }: { rows: T[]; cols: { key: string; label: string; render: (r: T) => ReactNode; className?: string }[]; empty?: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-100">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={`px-3 py-2 font-medium ${c.className || ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100 bg-white">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-ink-50/60">
              {cols.map((c) => (
                <td key={c.key} className={`px-3 py-2 align-top ${c.className || ''}`}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Disclosure({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-ink-100 bg-white">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left font-medium" onClick={() => setOpen(!open)}>
        {title}
        <span className="text-ink-300">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-ink-100 px-4 py-3">{children}</div>}
    </div>
  );
}

export function NavLink({ href, children, active }: { href: string; children: ReactNode; active?: boolean }) {
  return (
    <Link href={href} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}>
      {children}
    </Link>
  );
}
