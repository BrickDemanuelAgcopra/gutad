'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { API_URL, money, when } from '@/lib/api';
import { Alert, Badge, Button, Card, Input, Select, Table, Textarea } from '@/components/ui';

interface PortalPO { id: string; reference: string; kitchen: string; status: string; createdAt: string; receivedAt: string | null; canInvoice: boolean; invoiceNumber: string | null; matchStatus: string | null; lines: { ingredientId: string; name: string; unit: string; orderedQty: number; receivedQty: number | null; unitCostCents: number }[] }
interface Portal { supplier: { id: string; name: string }; purchaseOrders: PortalPO[]; submissions: { id: string; source: string; invoiceNumber: string | null; purchaseOrderId: string | null; status: string; totalCents: number | null; error: string | null; createdAt: string }[] }

/** 21.8-P supplier invoice portal: a per-supplier link (no account) to invoice received purchase orders or upload EDI 810 / CSV. */
export default function SupplierPortal() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Portal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [po, setPo] = useState<PortalPO | null>(null);
  const [inv, setInv] = useState({ number: '', lines: {} as Record<string, { qty: string; price: string }> });
  const [upload, setUpload] = useState({ format: 'edi810', document: '' });

  const call = useCallback(async <T,>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-supplier-token': token }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(Array.isArray(json.message) ? json.message.join('; ') : json.message || `Error ${res.status}`);
    return json as T;
  }, [token]);
  const load = useCallback(async () => { try { setData(await call<Portal>('GET', '/supplier-portal')); setError(null); } catch (e) { setError((e as Error).message); } }, [call]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<void>) => { setError(null); setMsg(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  const pick = (p: PortalPO) => { setPo(p); setInv({ number: '', lines: Object.fromEntries(p.lines.map((l) => [l.ingredientId, { qty: String(l.receivedQty ?? l.orderedQty), price: (l.unitCostCents / 100).toFixed(2) }])) }); };
  if (!data) return <div className="mx-auto max-w-3xl py-10">{error ? <Alert>{error}</Alert> : <p className="text-sm text-ink-500">Loading…</p>}</div>;
  return (
    <div className="mx-auto max-w-4xl space-y-4 py-6">
      <div><h1 className="text-2xl font-bold">Invoices · {data.supplier.name}</h1><p className="text-sm text-ink-500">Send invoices for delivered purchase orders. They are matched against what was ordered and received.</p></div>
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="good">{msg}</Alert>}
      <Card title="Purchase orders">
        <Table rows={data.purchaseOrders} empty="No open purchase orders." cols={[
          { key: 'r', label: 'PO', render: (p) => <span className="font-mono text-xs">{p.reference}</span> }, { key: 'k', label: 'Deliver to', render: (p) => p.kitchen },
          { key: 's', label: 'Status', render: (p) => <span><Badge tone={p.status === 'RECEIVED' ? 'good' : 'info'}>{p.status.toLowerCase()}</Badge>{p.matchStatus && <Badge tone={p.matchStatus === 'MATCHED' ? 'good' : 'warn'}>{p.matchStatus.toLowerCase()} {p.invoiceNumber}</Badge>}</span> },
          { key: 'd', label: 'Received', render: (p) => <span className="text-xs">{when(p.receivedAt)}</span> },
          { key: 'x', label: '', render: (p) => p.canInvoice && p.matchStatus !== 'MATCHED' ? <Button size="sm" onClick={() => pick(p)}>Invoice</Button> : null },
        ]} />
      </Card>
      {po && (
        <Card title={`Invoice for PO ${po.reference}`}>
          <Input label="Invoice number" value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} />
          <table className="mt-2 w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th>Item</th><th>Received</th><th>Invoiced qty</th><th>Unit price ($)</th></tr></thead><tbody>
            {po.lines.map((l) => <tr key={l.ingredientId} className="border-t border-ink-50"><td className="py-1">{l.name} <span className="text-xs text-ink-500">{l.unit}</span></td><td>{l.receivedQty ?? '—'}</td><td><input className="w-24 rounded border border-ink-100 px-1" value={inv.lines[l.ingredientId]?.qty ?? ''} onChange={(e) => setInv({ ...inv, lines: { ...inv.lines, [l.ingredientId]: { ...inv.lines[l.ingredientId], qty: e.target.value } } })} /></td><td><input className="w-24 rounded border border-ink-100 px-1" value={inv.lines[l.ingredientId]?.price ?? ''} onChange={(e) => setInv({ ...inv, lines: { ...inv.lines, [l.ingredientId]: { ...inv.lines[l.ingredientId], price: e.target.value } } })} /></td></tr>)}
          </tbody></table>
          <div className="mt-2 flex gap-2"><Button disabled={!inv.number} onClick={() => act(async () => { const r = await call<{ status: string; error: string | null; varianceCents: number | null }>('POST', '/supplier-portal/invoices', { purchaseOrderId: po.id, invoiceNumber: inv.number, lines: po.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: Number(inv.lines[l.ingredientId]?.qty) || 0, unitCostCents: Math.round(Number(inv.lines[l.ingredientId]?.price) * 100) || 0 })) }); setMsg(r.status === 'MATCHED' ? 'Invoice received and matched.' : r.status === 'VARIANCE' ? `Invoice received with a variance of ${money(r.varianceCents || 0)}; the buyer will review it.` : `Invoice rejected: ${r.error}`); setPo(null); })}>Submit invoice</Button><Button variant="ghost" onClick={() => setPo(null)}>Cancel</Button></div>
        </Card>
      )}
      <Card title="Upload EDI 810 or CSV">
        <div className="grid gap-2 sm:grid-cols-4"><Select label="Format" value={upload.format} onChange={(e) => setUpload({ ...upload, format: e.target.value })}><option value="edi810">X12 EDI 810</option><option value="csv">CSV</option></Select></div>
        <Textarea className="mt-2" label={upload.format === 'csv' ? 'CSV: po, invoice_number, item, quantity, unit_price' : 'X12 810 document (BIG04 = PO number shown above)'} rows={6} value={upload.document} onChange={(e) => setUpload({ ...upload, document: e.target.value })} />
        <input type="file" accept=".edi,.x12,.txt,.csv" className="mt-2 text-xs" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setUpload({ ...upload, document: await f.text() }); }} />
        <Button className="mt-2" disabled={!upload.document.trim()} onClick={() => act(async () => { const r = await call<{ invoices: number; results: { invoiceNumber: string; status: string; error: string | null }[] }>('POST', '/supplier-portal/edi', upload); setMsg(`${r.invoices} invoice(s): ${r.results.map((x) => `${x.invoiceNumber} ${x.status.toLowerCase()}${x.error ? ` (${x.error})` : ''}`).join('; ')}`); setUpload({ ...upload, document: '' }); })}>Upload</Button>
      </Card>
      <Card title="Recent submissions">
        <Table rows={data.submissions} empty="Nothing submitted yet." cols={[{ key: 'd', label: 'When', render: (s) => <span className="text-xs">{when(s.createdAt)}</span> }, { key: 'i', label: 'Invoice', render: (s) => `${s.invoiceNumber || '—'} (${s.source.replace('_', ' ').toLowerCase()})` }, { key: 't', label: 'Total', render: (s) => (s.totalCents == null ? '—' : money(s.totalCents)) }, { key: 's', label: 'Result', render: (s) => <span><Badge tone={s.status === 'MATCHED' ? 'good' : s.status === 'VARIANCE' ? 'warn' : 'bad'}>{s.status.toLowerCase()}</Badge>{s.error && <span className="block text-xs text-red-700">{s.error}</span>}</span> }]} />
      </Card>
    </div>
  );
}
