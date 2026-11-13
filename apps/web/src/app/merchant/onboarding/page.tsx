'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, downloadFile, money, uploadFile, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Spinner, statusTone } from '@/components/ui';
import { MerchantAgreementText } from '@/components/merchant-agreement';
import { useMerchant } from '../context';

export interface Onboarding {
  agreementVersion: string;
  agreement: { acceptedAt: string; signatureName: string; signatureTitle: string | null } | null;
  orderForm: { id: string; name: string; planCode: string; version: number; marketplaceCommissionBps: number; directCommissionBps: number; subscriptionCents: number; subscriptionInterval: string; processingBps: number; processingFixedCents: number; effectiveFrom: string; signedAt: string | null } | null;
  documentTypes: { type: string; label: string; required: boolean; status: string; reviewNote: string | null }[];
  documents: { id: string; docType: string; fileName: string; sizeBytes: number; status: string; reviewNote: string | null; createdAt: string; locationId: string | null }[];
  locations: { id: string; name: string; status: string; verifiedAt: string | null }[];
  blockers: string[];
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/** Merchant onboarding: accept the Merchant Agreement + Order Form, upload documents, then Gutad verifies. */
export default function OnboardingPage() {
  const { org, reload: reloadOrg } = useMerchant();
  const { data: ob, reload } = useApi<Onboarding>(org ? `/organizations/${org.id}/onboarding` : null, { deps: [org?.id] });
  const { run, error, busy } = useAction();
  const [sig, setSig] = useState({ name: '', title: '', agree: false });
  const [docType, setDocType] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  if (!org) return null;
  if (!ob) return <Spinner />;
  const signed = !!ob.agreement && (!ob.orderForm || !!ob.orderForm.signedAt);
  const required = ob.documentTypes.filter((d) => d.required);
  const docsDone = required.every((d) => d.status === 'APPROVED');
  const docsSent = required.every((d) => d.status !== 'MISSING' && d.status !== 'REJECTED');
  const live = ob.locations.some((l) => l.verifiedAt);
  const steps = [
    { label: 'Accept the agreement', done: signed },
    { label: 'Upload documents', done: docsSent },
    { label: 'Gutad review', done: docsDone && ob.blockers.length === 0 },
    { label: 'Activation', done: live },
  ];
  const accept = () => run(async () => {
    await api.post(`/organizations/${org.id}/onboarding/accept`, { agreementVersion: ob.agreementVersion, signatureName: sig.name, signatureTitle: sig.title || undefined, contractId: ob.orderForm && !ob.orderForm.signedAt ? ob.orderForm.id : undefined });
    reload();
  });
  const upload = () => run(async () => {
    const f = fileRef.current?.files?.[0];
    if (!f || !docType) throw new Error('Choose a document type and a file');
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', f);
    await uploadFile(`/organizations/${org.id}/documents`, form);
    if (fileRef.current) fileRef.current.value = '';
    setDocType('');
    reload();
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Onboarding</h1>
      <ol className="grid gap-2 sm:grid-cols-4">
        {steps.map((s, i) => <li key={s.label} className={`rounded-xl border px-3 py-2 text-sm ${s.done ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-ink-100 bg-white text-ink-700'}`}><span className="font-semibold">{s.done ? '✓' : i + 1}.</span> {s.label}</li>)}
      </ol>
      {live ? <Alert tone="good">You&apos;re verified. <Link className="underline" href="/merchant/settings">Go live from Settings</Link> when your menu and hours are ready.</Alert>
        : ob.blockers.length > 0 && <Alert tone="info">Before Gutad can activate you: {ob.blockers.join(' · ')}.</Alert>}
      {error && <Alert>{error}</Alert>}

      <Card title="1. Merchant Agreement and Order Form" action={signed ? <Badge tone="good">Signed</Badge> : <Badge tone="warn">Action needed</Badge>}>
        {ob.orderForm ? (
          <div className="mb-4 rounded-xl bg-ink-50 p-3 text-sm">
            <div className="font-semibold">Order Form: {ob.orderForm.name} (v{ob.orderForm.version})</div>
            <div className="mt-1 grid gap-x-4 gap-y-0.5 text-ink-700 sm:grid-cols-2">
              <span>Marketplace commission: {pct(ob.orderForm.marketplaceCommissionBps)}</span>
              <span>Direct-order commission: {pct(ob.orderForm.directCommissionBps)}</span>
              <span>Subscription: {ob.orderForm.subscriptionCents ? `${money(ob.orderForm.subscriptionCents)}/${ob.orderForm.subscriptionInterval.toLowerCase()}` : 'none'}</span>
              <span>Card processing: {pct(ob.orderForm.processingBps)} + {money(ob.orderForm.processingFixedCents)}</span>
              <span>Effective: {when(ob.orderForm.effectiveFrom)}</span>
              <span>{ob.orderForm.signedAt ? `Signed ${when(ob.orderForm.signedAt)}` : 'Not signed yet'}</span>
            </div>
          </div>
        ) : (
          <p className="mb-4 text-sm text-ink-500">Gutad will send your Order Form (your commission and fees). It appears here for you to sign. You can accept the Merchant Agreement now.</p>
        )}
        <div className="max-h-72 overflow-y-auto rounded-xl border border-ink-100 p-4"><MerchantAgreementText /></div>
        {ob.agreement && (!ob.orderForm || ob.orderForm.signedAt) ? (
          <p className="mt-3 text-sm text-ink-700">Accepted by <b>{ob.agreement.signatureName}</b>{ob.agreement.signatureTitle ? `, ${ob.agreement.signatureTitle}` : ''} on {when(ob.agreement.acceptedAt)}.</p>
        ) : (
          <div className="mt-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input label="Full legal name (your signature)" value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} />
              <Input label="Title" placeholder="Owner" value={sig.title} onChange={(e) => setSig({ ...sig, title: e.target.value })} />
            </div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={sig.agree} onChange={(e) => setSig({ ...sig, agree: e.target.checked })} /> I&apos;m authorized to sign for {org.name} and accept the Merchant Agreement{ob.orderForm && !ob.orderForm.signedAt ? ' and the Order Form above' : ''}.</label>
            <Button disabled={!sig.agree || sig.name.trim().length < 2 || busy} onClick={accept}>{ob.agreement ? 'Sign Order Form' : 'Accept and sign'}</Button>
            <p className="text-xs text-ink-500">Only the account owner can sign. We record your name, the time and your IP address with the signature.</p>
          </div>
        )}
      </Card>

      <Card title="2. Business documents" action={docsDone ? <Badge tone="good">Approved</Badge> : docsSent ? <Badge tone="info">In review</Badge> : <Badge tone="warn">Action needed</Badge>}>
        <ul className="divide-y divide-ink-100 text-sm">
          {ob.documentTypes.map((d) => (
            <li key={d.type} className="flex items-center justify-between gap-2 py-2">
              <span>{d.label}{!d.required && <span className="text-ink-300"> (optional)</span>}{d.reviewNote && <span className="block text-xs text-red-600">Rejected: {d.reviewNote}</span>}</span>
              <Badge tone={d.status === 'MISSING' ? (d.required ? 'warn' : 'neutral') : statusTone(d.status === 'SUBMITTED' ? 'PENDING' : d.status)}>{d.status === 'MISSING' ? 'Not uploaded' : d.status === 'SUBMITTED' ? 'In review' : d.status === 'APPROVED' ? 'Approved' : 'Rejected'}</Badge>
            </li>
          ))}
        </ul>
        <div className="mt-3 grid gap-2 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <Select label="Document type" value={docType} onChange={(e) => setDocType(e.target.value)}><option value="">Choose…</option>{ob.documentTypes.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}</Select>
          <label className="text-sm"><span className="mb-1 block text-ink-700">File (PDF or image, up to 10 MB)</span><input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" className="block w-full text-sm" /></label>
          <Button disabled={busy || !docType} onClick={upload}>Upload</Button>
        </div>
        {ob.documents.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase text-ink-500">Uploaded</div>
            <ul className="mt-1 text-sm">{ob.documents.map((d) => <li key={d.id} className="flex items-center justify-between py-1"><button className="truncate text-left underline" onClick={() => run(() => downloadFile(`/documents/${d.id}/file`, d.fileName))}>{d.fileName}</button><span className="ml-2 shrink-0 text-xs text-ink-500">{ob.documentTypes.find((t) => t.type === d.docType)?.label} · {when(d.createdAt)} · {d.status.toLowerCase()}</span></li>)}</ul>
          </div>
        )}
      </Card>

      <Card title="3. Set up your restaurant">
        <ul className="list-inside list-disc text-sm text-ink-700">
          <li><Link className="underline" href="/merchant/menu">Menu</Link>: dishes, prices, descriptions, options and allergens.</li>
          <li><Link className="underline" href="/merchant/settings">Settings</Link>: hours, preparation time and pickup details for couriers.</li>
          <li><Link className="underline" href="/merchant/finance">Finance</Link>: payout account for weekly payouts.</li>
        </ul>
        <button className="mt-2 text-xs text-ink-500 underline" onClick={() => { reload(); reloadOrg(); }}>Refresh status</button>
      </Card>
    </div>
  );
}
