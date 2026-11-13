'use client';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { AuthResponse } from '@gutad/shared';
import { api, money, session, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, statusTone, Textarea } from '@/components/ui';

/** Ask for a reason before a sensitive action; returns null when the person cancels. */
export function askReason(what: string, min = 5): string | null {
  const r = window.prompt(`Reason for ${what} (saved in the audit trail):`);
  if (r === null) return null;
  if (r.trim().length < min) {
    window.alert(`Please give a reason of at least ${min} characters.`);
    return null;
  }
  return r.trim();
}

/** Calls that return fresh tokens (MFA, emergency and support access) update the stored session. */
export function adoptTokens(res: unknown) {
  const r = res as Partial<AuthResponse>;
  if (r && r.accessToken && r.refreshToken && r.user) session.set(r as AuthResponse);
}

/** Banner for active emergency elevation or support access, with a button to end it. */
export function AccessBanner() {
  const { user } = useSession();
  const { run } = useAction();
  if (!user) return null;
  const el = user.elevated && new Date(user.elevated.until) > new Date() ? user.elevated : null;
  const sup = user.supportAccess && new Date(user.supportAccess.until) > new Date() ? user.supportAccess : null;
  if (!el && !sup && !user.mfaSetupRequired) return null;
  return (
    <div className="space-y-2">
      {user.mfaSetupRequired && <Alert tone="info">Your role requires two-factor authentication. <Link className="underline" href="/account?tab=security">Set it up</Link> to open the admin console.</Alert>}
      {el && <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"><span>🚨 Emergency access: <b>{el.roles.join(', ')}</b> until {when(el.until)}. Everything you do is tagged and reviewed.</span><Button size="sm" variant="danger" onClick={() => run(async () => adoptTokens(await api.post(`/access-grants/${el.grantId}/end`, {})))}>End now</Button></div>}
      {sup && <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><span>🛟 Support access to a merchant ({sup.readOnly ? 'read-only' : 'can make changes'}) until {when(sup.until)}.</span><Button size="sm" variant="secondary" onClick={() => run(async () => adoptTokens(await api.post(`/access-grants/${sup.grantId}/end`, {})))}>End session</Button></div>}
    </div>
  );
}

export interface Approval {
  id: string; kind: string; status: string; summary: string; organizationId: string | null; subjectType: string; subjectId: string; amountCents: number | null; reason: string;
  requestedById: string; requestedByEmail: string | null; requiredApprovals: number; approvals: { userId: string; email?: string; at: string; note?: string | null }[];
  decisionNote: string | null; result: unknown; expiresAt: string | null; createdAt: string; canDecide: boolean; payload: Record<string, unknown>;
}

/** Approval list with approve / reject / retry; shared by the admin console and merchant pages. */
export function ApprovalsTable({ query, empty, onChange }: { query: string; empty?: string; onChange?: () => void }) {
  const { user } = useSession();
  const { data, reload } = useApi<Approval[]>(`/approvals${query}`, { poll: 15000, deps: [query] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<Approval | null>(null);
  const [note, setNote] = useState('');
  const done = async () => { setOpen(null); setNote(''); await reload(); onChange?.(); };
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      {!data?.length ? <div className="rounded-xl border border-dashed border-ink-100 p-6 text-center text-sm text-ink-500">{empty || 'Nothing waiting.'}</div> : (
        <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white">
          {data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(a)}>
                <div className="flex flex-wrap items-center gap-2"><Badge>{a.kind.replace(/_/g, ' ')}</Badge><Badge tone={statusTone(a.status === 'EXECUTED' ? 'COMPLETED' : a.status)}>{a.status}</Badge>{a.amountCents ? <span className="text-sm font-semibold">{money(a.amountCents)}</span> : null}</div>
                <div className="mt-1 text-sm text-ink-900">{a.summary}</div>
                <div className="text-xs text-ink-500">{a.requestedById === user?.id ? 'You' : a.requestedByEmail} · {when(a.createdAt)} · “{a.reason}”</div>
              </button>
              <div className="flex gap-1">
                {a.canDecide && <Button size="sm" onClick={() => setOpen(a)}>Review</Button>}
                {a.status === 'PENDING' && a.requestedById === user?.id && <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/approvals/${a.id}/cancel`, {}); await done(); })}>Withdraw</Button>}
                {a.status === 'FAILED' && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/approvals/${a.id}/retry`, {}); await done(); })}>Retry</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? open.summary : ''}>
        {open && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-ink-500">Kind</span><div className="font-medium">{open.kind.replace(/_/g, ' ')}</div></div>
              <div><span className="text-ink-500">Status</span><div className="font-medium">{open.status}</div></div>
              <div><span className="text-ink-500">Requested by</span><div className="font-medium">{open.requestedByEmail || open.requestedById.slice(0, 8)}</div></div>
              <div><span className="text-ink-500">Expires</span><div className="font-medium">{when(open.expiresAt)}</div></div>
            </div>
            <div className="rounded-lg bg-ink-50 p-2"><div className="text-xs text-ink-500">Reason</div>{open.reason}</div>
            <details className="text-xs"><summary className="cursor-pointer text-ink-500">Details</summary><pre className="mt-1 overflow-auto rounded bg-ink-50 p-2">{JSON.stringify(open.payload, null, 2)}</pre></details>
            {open.approvals.length > 0 && <div className="text-xs">Approved by {open.approvals.map((x) => x.email || x.userId.slice(0, 8)).join(', ')}</div>}
            {open.decisionNote && <div className="text-xs">Decision note: {open.decisionNote}</div>}
            {open.canDecide && (
              <>
                <Textarea label="Note (required to reject)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2"><Button onClick={() => run(async () => { await api.post(`/approvals/${open.id}/approve`, { note: note || undefined }); await done(); })}>Approve</Button><Button variant="danger" onClick={() => run(async () => { await api.post(`/approvals/${open.id}/reject`, { note }); await done(); })}>Reject</Button></div>
                <p className="text-xs text-ink-500">You cannot approve your own requests. The change happens only after the final approval.</p>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Pending-approval notice after an action was routed to the approval engine. */
export function pendingNotice(res: unknown): string | null {
  const r = res as { status?: string; approval?: { summary: string } };
  return r && r.status === 'PENDING_APPROVAL' ? `Sent for approval: ${r.approval?.summary}. It applies once someone else approves it.` : null;
}

export function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-2"><div><h1 className="text-2xl font-bold">{title}</h1>{hint && <p className="text-sm text-ink-500">{hint}</p>}</div>{action}</div>;
}

export function KeyValue({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{rows.map(([k, v]) => <Fragment key={k}><dt className="text-ink-500">{k}</dt><dd>{v}</dd></Fragment>)}</dl>;
}

export { Card, Input };
