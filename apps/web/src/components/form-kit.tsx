'use client';
/**
 * Modern form primitives used by the Chef Network (and reusable elsewhere): step progress, radio cards,
 * segmented buttons, chip groups, −/+ steppers, a drag-or-click file drop, and a debounced autosave hook.
 * Everything works with keyboard and pointer clicks; nothing depends on dragging.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div>
      {label && <div className="mb-1 flex justify-between text-xs text-ink-500"><span>{label}</span><span className="font-semibold text-ink-700">{p}%</span></div>}
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export interface StepItem { key: string; label: string; complete?: boolean; flagged?: boolean; hint?: string }

/** Vertical step list on desktop, horizontal scroller on phones. Steps are always clickable (resumable, any order). */
export function StepNav({ steps, active, onSelect }: { steps: StepItem[]; active: string; onSelect: (k: string) => void }) {
  return (
    <nav aria-label="Application steps" className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible">
      {steps.map((s, i) => {
        const on = s.key === active;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            aria-current={on ? 'step' : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${on ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}
          >
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${s.flagged ? 'bg-amber-100 text-amber-700' : s.complete ? 'bg-emerald-500 text-white' : on ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-500'}`}>{s.flagged ? '!' : s.complete ? '✓' : i + 1}</span>
            <span className="whitespace-nowrap lg:whitespace-normal">{s.label}{s.hint && <span className="block text-xs font-normal text-ink-500">{s.hint}</span>}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** Large selectable cards for a single choice (radio semantics). */
export function RadioCards<T extends string>({ value, onChange, options, columns = 2, name }: { value: T | undefined | null; onChange: (v: T) => void; options: { value: T; label: ReactNode; description?: ReactNode; extra?: ReactNode; disabled?: boolean }[]; columns?: 1 | 2 | 3; name: string }) {
  const cols = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }[columns];
  return (
    <div role="radiogroup" aria-label={name} className={`grid gap-2 ${cols}`}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${on ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-ink-100 bg-white hover:border-ink-300'}`}
          >
            <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-brand-500' : 'border-ink-300'}`}>{on && <span className="h-2 w-2 rounded-full bg-brand-500" />}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2 text-sm font-medium text-ink-900">{o.label}{o.extra && <span className="text-xs font-semibold text-ink-700">{o.extra}</span>}</span>
              {o.description && <span className="mt-0.5 block text-xs text-ink-500">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control, e.g. None / Light / Standard / Extra. */
export function Segmented<T extends string>({ value, onChange, options, name, size = 'md' }: { value: T | undefined | null; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; name: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={name} className="inline-flex flex-wrap gap-1 rounded-xl bg-ink-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-lg font-medium transition disabled:opacity-40 ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'} ${value === o.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select chips (cuisines, cooking days, allergens). */
export function ChipGroup<T extends string | number>({ values, onChange, options, name, max }: { values: T[]; onChange: (v: T[]) => void; options: { value: T; label: ReactNode }[]; name: string; max?: number }) {
  return (
    <div role="group" aria-label={name} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            disabled={!on && !!max && values.length >= max}
            onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${on ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-100 bg-white text-ink-700 hover:border-ink-300'}`}
          >
            {on ? '✓ ' : ''}{o.label}
          </button>
        );
      })}
    </div>
  );
}

/** −/+ quantity control with min/max. */
export function QtyStepper({ value, onChange, min = 0, max = 99, label, size = 'md' }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; size?: 'sm' | 'md' }) {
  const b = size === 'sm' ? 'h-7 w-7 text-sm' : 'h-9 w-9 text-lg';
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-ink-100 bg-white p-0.5" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className={`${b} grid place-items-center rounded-full font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-30`}>−</button>
      <span className="min-w-[1.75rem] text-center text-sm font-semibold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className={`${b} grid place-items-center rounded-full font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-30`}>+</button>
    </div>
  );
}

/** Drop a file or click to choose (camera on phones when accept is an image). Shows an image preview. */
export function FileDrop({ accept, onFile, busy, label, hint, previewUrl, capture }: { accept: string; onFile: (f: File) => void; busy?: boolean; label: string; hint?: string; previewUrl?: string | null; capture?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      className={`flex items-center gap-3 rounded-xl border-2 border-dashed p-3 transition ${over ? 'border-brand-500 bg-brand-50' : 'border-ink-100 bg-white'}`}
    >
      {previewUrl && <img src={previewUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        <div className="text-xs text-ink-500">{busy ? 'Uploading…' : hint || 'Drag a file here or choose one'}</div>
      </div>
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="shrink-0 rounded-lg border border-ink-100 bg-white px-3 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-50">{previewUrl ? 'Replace' : 'Choose file'}</button>
      <input ref={input} type="file" accept={accept} {...(capture ? { capture: 'environment' as const } : {})} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </div>
  );
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Debounced autosave: call `queue(value)` on every edit; it saves after `delay` ms of quiet and on unmount. */
export function useAutosave<T>(save: (v: T) => Promise<unknown>, delay = 700) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ v: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState('saving');
    try {
      await saveRef.current(p.v);
      setState('saved');
      setError(null);
    } catch (e) {
      setState('error');
      setError((e as Error).message);
    }
  }, []);
  const queue = useCallback((v: T) => {
    pending.current = { v };
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  }, [delay, flush]);
  useEffect(() => () => { void flush(); }, [flush]);
  return { state, error, queue, flush };
}

export function SaveBadge({ state, error }: { state: SaveState; error?: string | null }) {
  const t = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: error ? `Not saved: ${error}` : 'Not saved' }[state];
  if (!t) return null;
  return <span className={`text-xs ${state === 'error' ? 'text-red-600' : 'text-ink-500'}`} aria-live="polite">{state === 'saved' ? '✓ ' : ''}{t}</span>;
}

/**
 * Reorderable list: drag a row by its handle (pointer) or use the ↑ ↓ buttons (keyboard and touch), per W3C's
 * requirement for a non-dragging alternative. Calls onChange with the new order.
 */
export function SortableList<T>({ items, getKey, onChange, render, label }: { items: T[]; getKey: (t: T) => string; onChange: (next: T[]) => void; render: (t: T, i: number) => ReactNode; label: (t: T) => string }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  return (
    <ul className="space-y-2">
      {items.map((t, i) => (
        <li
          key={getKey(t)}
          draggable
          onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { e.preventDefault(); setOver(i); }}
          onDragLeave={() => setOver((o) => (o === i ? null : o))}
          onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}
          onDragEnd={() => { setDrag(null); setOver(null); }}
          className={`flex items-stretch gap-2 rounded-xl border bg-white transition ${drag === i ? 'opacity-50' : ''} ${over === i && drag !== null && drag !== i ? 'border-brand-500 ring-2 ring-brand-100' : 'border-ink-100'}`}
        >
          <span className="flex cursor-grab select-none items-center px-2 text-ink-300 active:cursor-grabbing" aria-hidden title="Drag to reorder">⋮⋮</span>
          <div className="min-w-0 flex-1 py-2">{render(t, i)}</div>
          <div className="flex flex-col justify-center gap-0.5 pr-2">
            <button type="button" aria-label={`Move ${label(t)} up`} disabled={i === 0} onClick={() => move(i, i - 1)} className="rounded px-1.5 text-xs text-ink-500 hover:bg-ink-50 disabled:opacity-30">↑</button>
            <button type="button" aria-label={`Move ${label(t)} down`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)} className="rounded px-1.5 text-xs text-ink-500 hover:bg-ink-50 disabled:opacity-30">↓</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
