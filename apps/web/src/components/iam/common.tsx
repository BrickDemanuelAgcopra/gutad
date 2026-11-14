'use client';
import Link from 'next/link';
import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Alert, Badge, Button, Input, Modal } from '@/components/ui';
import { useApi } from '@/lib/hooks';

// ───── shapes returned by /admin/iam/* ─────

export interface RoleRef { assignmentId: string | null; roleId: string | null; key: string; name: string; kind: string; primary: boolean; responsibility: string | null; startsAt: string; endsAt: string | null; state: string }
export interface StaffRow {
  id: string; email: string; name: string | null; phone: string | null; status: string; statusReason: string | null;
  title: string | null; department: string | null; team: string | null; managerId: string | null; employeeId: string | null; suspendedUntil: string | null;
  mfaEnabled: boolean; lastLoginAt: string | null; lastSeenAt: string | null; sessions: number; inactive: boolean;
  invitation: { id: string; expiresAt: string; sentCount: number; lastSentAt: string } | null; scoped: boolean; roles: RoleRef[]; createdAt: string;
}
export interface Role { id: string; key: string; name: string; description: string; kind: 'SYSTEM' | 'CUSTOM'; status: string; permissions: string[]; approvalLimits: Record<string, number>; mfaRequired: boolean; requestable: boolean; holders: number; privileged: boolean; archivedAt: string | null }
export interface SessionRow { id: string; userId?: string; email?: string; name?: string | null; amr: string[]; client: string | null; ip: string | null; userAgent: string | null; lastSeenAt: string; createdAt: string; expiresAt: string; current: boolean }
export interface LoginEvent { id: string; userId: string | null; email: string | null; outcome: string; method: string; reason: string | null; ip: string | null; userAgent: string | null; suspicious: boolean; createdAt: string }
export type StepUpProof = { password?: string; code?: string };

export const SUPERADMIN = 'PLATFORM_ADMIN';
export const TEAMS = ['SUPPORT', 'OPERATIONS', 'FINANCE', 'FOOD_SAFETY', 'DELIVERY'] as const;

export const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—');
/** `<input type="datetime-local">` value → ISO string (null when empty). */
export const isoOrNull = (v: string) => (v ? new Date(v).toISOString() : null);
export const toLocalInput = (d?: string | null) => {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function statusBadge(s: string) {
  const tone = s === 'ACTIVE' ? 'good' : s === 'INVITED' ? 'info' : s === 'SUSPENDED' ? 'warn' : s === 'ARCHIVED' ? 'neutral' : 'bad';
  return <Badge tone={tone}>{s}</Badge>;
}

export function RoleChips({ roles }: { roles: RoleRef[] }) {
  if (!roles.length) return <span className="text-xs text-ink-500">No roles</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r, i) => (
        <span key={`${r.key}-${i}`} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${r.key === SUPERADMIN ? 'bg-red-100 text-red-800' : 'bg-sky-100 text-sky-800'}`} title={r.responsibility || undefined}>
          {r.primary && <span title="Primary role">★</span>}
          {r.name}
          {r.state === 'SCHEDULED' && <span className="rounded bg-white/70 px-1 text-[10px] uppercase">scheduled {day(r.startsAt)}</span>}
          {r.endsAt && <span className="rounded bg-white/70 px-1 text-[10px]">until {day(r.endsAt)}</span>}
          {r.kind === 'ACTING' && <span className="rounded bg-white/70 px-1 text-[10px] uppercase">acting</span>}
        </span>
      ))}
    </div>
  );
}

// ───── API error helpers ─────

interface ErrBody { code?: string; method?: string; message?: string | string[] }
export const errBody = (e: unknown): ErrBody | null => ((e as { body?: ErrBody | null })?.body ?? null);
export const errStatus = (e: unknown): number | undefined => (e as { status?: number })?.status;

/** `{ status: 'PENDING_APPROVAL' }` results (dual control) → a notice for the person. */
export function pendingApprovalText(res: unknown): string | null {
  const r = res as { status?: string; approval?: { summary?: string } } | null;
  if (r?.status !== 'PENDING_APPROVAL') return null;
  return `Sent for approval${r.approval?.summary ? `: ${r.approval.summary}` : ''}. A second superadmin must approve it in Admin → Approvals before it applies.`;
}

export function Notice({ text, onClose }: { text: string | null; onClose: () => void }) {
  if (!text) return null;
  const pending = text.startsWith('Sent for approval');
  return (
    <div className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${pending ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-100 bg-emerald-50 text-emerald-800'}`}>
      <span>{text}{pending && <> <Link className="underline" href="/admin/approvals">Open approvals</Link></>}</span>
      <button className="text-xs opacity-70 hover:opacity-100" onClick={onClose}>✕</button>
    </div>
  );
}

// ───── step-up verification ─────

type WithStepUp = <T>(fn: (stepUp?: StepUpProof) => Promise<T>) => Promise<T>;
const StepUpCtx = createContext<WithStepUp | null>(null);

/**
 * Wraps calls that may answer 403 STEP_UP_REQUIRED: asks for a password or authenticator code and retries the
 * same call with `stepUp`. Render once around the IAM page; use `useStepUp()` inside.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<{ method: string | null; message: string } | null>(null);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const resolver = useRef<((p: StepUpProof | null) => void) | null>(null);
  const prompt = (method: string | null, message: string) =>
    new Promise<StepUpProof | null>((resolve) => {
      setPw('');
      setCode('');
      resolver.current = resolve;
      setAsk({ method, message });
    });
  const finish = (p: StepUpProof | null) => {
    resolver.current?.(p);
    resolver.current = null;
    setAsk(null);
  };
  const withStepUp = useCallback<WithStepUp>(async (fn) => {
    let proof: StepUpProof | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fn(proof);
      } catch (e) {
        const b = errBody(e);
        if (errStatus(e) !== 403 || b?.code !== 'STEP_UP_REQUIRED') throw e;
        const msg = typeof b.message === 'string' ? b.message : 'Confirm it is you to make this change.';
        const p = await prompt(b.method || null, proof ? `That did not match. ${msg}` : msg);
        if (!p) throw new Error('Change canceled: it needs your confirmation.');
        proof = p;
      }
    }
    throw new Error('Too many confirmation attempts. Try again.');
  }, []);
  const m = ask?.method;
  const ready = (m !== 'password' && /^\d{6}$/.test(code.trim())) || (m !== 'totp' && pw.length > 0);
  const submit = () => ready && finish({ ...(code.trim() && m !== 'password' ? { code: code.trim() } : {}), ...(pw && m !== 'totp' ? { password: pw } : {}) });
  return (
    <StepUpCtx.Provider value={withStepUp}>
      {children}
      <Modal open={!!ask} onClose={() => finish(null)} title="Confirm it's you">
        {ask && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-700">{ask.message}</p>
            {m !== 'password' && <Input label="6-digit code from your authenticator app" autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} />}
            {!m && <div className="text-center text-xs text-ink-500">or</div>}
            {m !== 'totp' && <Input label="Your password" type="password" autoFocus={m === 'password'} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => finish(null)}>Cancel</Button><Button disabled={!ready} onClick={submit}>Confirm</Button></div>
          </div>
        )}
      </Modal>
    </StepUpCtx.Provider>
  );
}

export function useStepUp(): WithStepUp {
  const ctx = useContext(StepUpCtx);
  if (!ctx) throw new Error('useStepUp needs <StepUpProvider>');
  return ctx;
}

// ───── shared bits ─────

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Secret shown exactly once (invite links, API keys). */
export function SecretModal({ title, secret, note, onClose }: { title: string; secret: string | null; note: ReactNode; onClose: () => void }) {
  return (
    <Modal open={!!secret} onClose={onClose} title={title}>
      {secret && (
        <div className="space-y-3 text-sm">
          <Alert tone="info">{note}</Alert>
          <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all rounded-lg bg-ink-50 px-3 py-2 text-xs">{secret}</code><CopyButton text={secret} /></div>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}

/** Wider modal for detail views (the base Modal is narrow). */
export function Panel({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function useRoles(archived = false) {
  return useApi<Role[]>(`/admin/iam/roles${archived ? '?archived=true' : ''}`, { deps: [archived] });
}

export function useStaff() {
  return useApi<StaffRow[]>('/admin/iam/users');
}

export const personLabel = (u?: { email: string; name: string | null } | null) => (u ? (u.name ? `${u.name} (${u.email})` : u.email) : '—');

export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-semibold text-ink-500">{children}</div>;
}
