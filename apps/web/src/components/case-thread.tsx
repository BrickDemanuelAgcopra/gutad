'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Select, Textarea } from '@/components/ui';

interface Msg { id: string; authorRole: string; authorEmail: string | null; visibility: string; body: string; createdAt: string }

/** Conversation on a support case; staff can reply to the parties or leave internal notes, with approved templates. */
export function CaseThread({ incidentId }: { incidentId: string }) {
  const { data, reload } = useApi<Msg[]>(`/incidents/${incidentId}/messages`, { deps: [incidentId] });
  const { data: tpls } = useApi<{ key: string; title: string; body: string }[]>('/message-templates');
  const { run, error } = useAction();
  const [body, setBody] = useState('');
  const [vis, setVis] = useState('PARTIES');
  return (
    <div className="mt-3 border-t border-ink-100 pt-3">
      <div className="text-xs font-semibold text-ink-500">Conversation</div>
      {error && <Alert>{error}</Alert>}
      <div className="mt-1 space-y-1">{(data || []).map((m) => <div key={m.id} className={`rounded-lg p-2 text-sm ${m.visibility === 'INTERNAL' ? 'border border-dashed border-amber-300 bg-amber-50' : m.authorRole === 'STAFF' ? 'bg-sky-50' : 'bg-ink-50'}`}><div className="text-xs text-ink-500">{m.authorEmail} · {m.authorRole.toLowerCase()} · {when(m.createdAt)}{m.visibility === 'INTERNAL' ? ' · internal' : ''}</div>{m.body}</div>)}{data?.length === 0 && <p className="text-xs text-ink-500">No messages yet.</p>}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[160px_200px]"><Select value={vis} onChange={(e) => setVis(e.target.value)}><option value="PARTIES">Reply to parties</option><option value="INTERNAL">Internal note</option></Select><Select value="" onChange={(e) => { const t = tpls?.find((x) => x.key === e.target.value); if (t) setBody(t.body); }}><option value="">Use a template…</option>{tpls?.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}</Select></div>
      <Textarea className="mt-2" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      <Button className="mt-2" size="sm" disabled={!body} onClick={() => run(async () => { await api.post(`/incidents/${incidentId}/messages`, { body, visibility: vis }); setBody(''); reload(); })}>{vis === 'INTERNAL' ? 'Add note' : 'Send'}</Button>
    </div>
  );
}
