'use client';
import { useRef, useState } from 'react';
import { COURIER_DOC_KINDS, COURIER_DOC_LABELS } from '@gutad/shared';
import { api, API_URL, session, uploadFile } from '@/lib/api';
import { Alert, Button, Input, Select } from '@/components/ui';

/** Opens a stored file (16.2-U) with the session token; staff views are audited by the API. */
export async function openStoredFile(fileId: string) {
  const win = window.open('', '_blank');
  const res = await fetch(`${API_URL}/files/${fileId}`, { headers: session.token() ? { Authorization: `Bearer ${session.token()}` } : {} });
  if (!res.ok) { win?.close(); throw new Error(res.status === 403 ? 'No access to this file' : `Could not open the file (${res.status})`); }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url; else window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A courier document: uploaded file (opened with the session) or the link the courier gave. */
export function DocLink({ doc, label }: { doc: { fileUrl: string; fileId?: string | null }; label: string }) {
  const [err, setErr] = useState<string | null>(null);
  if (!doc.fileId) return <a className="underline" href={doc.fileUrl} target="_blank" rel="noreferrer">{label}</a>;
  return <span><button className="underline" onClick={() => openStoredFile(doc.fileId!).catch((e) => setErr((e as Error).message))}>{label}</button> <span className="text-[10px] uppercase text-ink-500">file</span>{err && <span className="ml-1 text-xs text-red-700">{err}</span>}</span>;
}

/** 16.2-U courier uploads a scan or photo straight to storage; a link is still accepted. */
export function CourierDocUpload({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<string>('LICENSE');
  const [expiresAt, setExpiresAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const exp = expiresAt ? new Date(`${expiresAt}T23:59:00Z`).toISOString() : '';
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (file) {
        const fd = new FormData();
        fd.append('kind', kind);
        if (exp) fd.append('expiresAt', exp);
        fd.append('file', file);
        await uploadFile('/driver/documents/upload', fd);
      } else {
        await api.post('/driver/documents', { kind, fileUrl: link, expiresAt: exp || undefined });
      }
      setFile(null); setLink(''); setExpiresAt('');
      if (input.current) input.current.value = '';
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 space-y-2">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-3">
        <Select label="Document" value={kind} onChange={(e) => setKind(e.target.value)}>{COURIER_DOC_KINDS.map((k) => <option key={k} value={k}>{COURIER_DOC_LABELS[k]}</option>)}</Select>
        <label className="block"><span className="mb-1 block text-xs font-medium text-ink-500">File (PDF or photo, up to 10 MB)</span><input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" className="w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <Input label="Expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </div>
      {!file && <Input label="…or a link to the scanned file" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />}
      <Button size="sm" disabled={busy || (!file && link.length < 4)} onClick={submit}>{busy ? 'Uploading…' : 'Upload'}</Button>
      <p className="text-xs text-ink-500">Files are stored privately; only you and Gutad’s courier team can open them.</p>
    </div>
  );
}
