import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { ingredients, kitchens, purchaseOrderLines, purchaseOrders, supplierAccessTokens, supplierInvoiceSubmissions, suppliers } from '../../db/schema';
import { assertCan, assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { InventoryService } from './inventory.service';
import { hashToken, newToken } from './tokens';

export interface ParsedInvoice { poRef: string; invoiceNumber: string; invoiceDate?: string; totalCents?: number; lines: { item: string; quantity: number; unitCostCents: number }[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** X12 810 (invoice): ST…SE groups with BIG (date, invoice no., PO date, PO no.), IT1 lines (qty, unit, price, id pairs), TDS total. */
export function parseEdi810(raw: string): ParsedInvoice[] {
  const text = raw.trim();
  if (!text.startsWith('ISA') && !text.startsWith('ST') && !text.includes('BIG')) throw new BadRequestException('Not an X12 810 document');
  // ISA sets the element separator (4th char); the segment terminator follows ISA16 (one char after the 16th separator)
  const el = text.startsWith('ISA') ? text[3] : '*';
  let segTerm = '~';
  if (text.startsWith('ISA')) {
    let pos = -1;
    for (let n = 0; n < 16; n++) { pos = text.indexOf(el, pos + 1); if (pos < 0) break; }
    if (pos >= 0 && text.length > pos + 2) segTerm = text[pos + 2];
  }
  if (segTerm === '\r') segTerm = '\n';
  const segs = text.split(segTerm).map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, '').trim()).filter(Boolean).map((s) => s.split(el));
  const out: ParsedInvoice[] = [];
  let cur: ParsedInvoice | null = null;
  for (const s of segs) {
    const id = s[0];
    if (id === 'ST' && s[1] === '810') cur = { poRef: '', invoiceNumber: '', lines: [] };
    else if (id === 'BIG' && cur) { cur.invoiceDate = s[1]; cur.invoiceNumber = s[2] || ''; cur.poRef = s[4] || ''; }
    else if (id === 'IT1' && cur) {
      const qty = Number(s[2]), price = Number(s[4]);
      const ids: string[] = [];
      for (let i = 6; i + 1 < s.length; i += 2) if (s[i + 1]) ids.push(s[i + 1]);
      if (!ids.length || !Number.isFinite(qty) || !Number.isFinite(price)) throw new BadRequestException(`Invalid IT1 line: ${s.join(el)}`);
      cur.lines.push({ item: ids[0], quantity: qty, unitCostCents: Math.round(price * 100) });
    } else if (id === 'TDS' && cur) cur.totalCents = Number(s[1]);
    else if (id === 'SE' && cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  if (!out.length) throw new BadRequestException('No 810 invoice found');
  for (const i of out) if (!i.invoiceNumber || !i.poRef || !i.lines.length) throw new BadRequestException('Each 810 needs BIG02 (invoice number), BIG04 (PO number) and IT1 lines');
  return out;
}

/** CSV with a header: po, invoice_number, item (ingredient id or name), quantity, and unit_price (dollars) or unit_cost_cents. */
export function parseInvoiceCsv(raw: string): ParsedInvoice[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new BadRequestException('The CSV needs a header row and at least one line');
  const split = (l: string) => { const out: string[] = []; let cell = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cell.trim()); cell = ''; } else cell += ch; } out.push(cell.trim()); return out; };
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iPo = col('po', 'po_number', 'purchase_order', 'purchase_order_id'), iInv = col('invoice_number', 'invoice'), iItem = col('item', 'ingredient', 'ingredient_id', 'sku'), iQty = col('quantity', 'qty'), iPrice = col('unit_price'), iCents = col('unit_cost_cents');
  if (iPo < 0 || iInv < 0 || iItem < 0 || iQty < 0 || (iPrice < 0 && iCents < 0)) throw new BadRequestException('CSV columns: po, invoice_number, item, quantity, unit_price (or unit_cost_cents)');
  const by = new Map<string, ParsedInvoice>();
  for (const l of lines.slice(1)) {
    const c = split(l);
    const key = `${c[iPo]}|${c[iInv]}`;
    const inv = by.get(key) || { poRef: c[iPo], invoiceNumber: c[iInv], lines: [] };
    const qty = Number(c[iQty]), cents = iCents >= 0 && c[iCents] !== '' ? Number(c[iCents]) : Math.round(Number(c[iPrice]) * 100);
    if (!c[iItem] || !Number.isFinite(qty) || !Number.isFinite(cents)) throw new BadRequestException(`Invalid CSV line: ${l}`);
    inv.lines.push({ item: c[iItem], quantity: qty, unitCostCents: Math.round(cents) });
    by.set(key, inv);
  }
  return [...by.values()];
}

/** 21.8-P supplier portal & EDI: suppliers submit invoices with a per-supplier token; submissions feed the three-way match. */
@Injectable()
export class SupplierPortalService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly inv: InventoryService) {}

  private async supplierFor(user: JwtPayload, supplierId: string, manage = true) {
    const [s] = await this.db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    if (!s) throw new NotFoundException('Supplier not found');
    if (s.organizationId) assertOrgAccess(user, s.organizationId, null, manage ? MANAGER_ROLES : undefined);
    else if (manage) assertCan(user, 'kitchens.manage', 'culinary.manage'); else assertCan(user, 'kitchens.read', 'culinary.manage');
    return s;
  }

  async tokens(user: JwtPayload, supplierId: string) {
    await this.supplierFor(user, supplierId, false);
    const list = await this.db.select().from(supplierAccessTokens).where(eq(supplierAccessTokens.supplierId, supplierId)).orderBy(desc(supplierAccessTokens.createdAt));
    const subs = await this.db.select().from(supplierInvoiceSubmissions).where(eq(supplierInvoiceSubmissions.supplierId, supplierId)).orderBy(desc(supplierInvoiceSubmissions.createdAt)).limit(50);
    return { tokens: list.map(({ tokenHash: _h, ...t }) => ({ ...t, active: !t.revokedAt && (!t.expiresAt || t.expiresAt > new Date()) })), submissions: subs.map(({ raw: _r, ...x }) => x) };
  }

  /** Issue a portal / EDI token; the plain token is returned once. */
  async issue(user: JwtPayload, supplierId: string, input: { label?: string; expiresInDays?: number }) {
    const s = await this.supplierFor(user, supplierId);
    const t = newToken('sup');
    const [row] = await this.db.insert(supplierAccessTokens).values({ supplierId, organizationId: s.organizationId, label: input.label ?? null, tokenHash: t.hash, tokenHint: t.hint, expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null, createdById: user.sub }).returning();
    await this.audit.log({ organizationId: s.organizationId, actorId: user.sub, action: 'supplier.portal_token_issue', entityType: 'supplier', entityId: supplierId, after: { tokenId: row.id, label: row.label, expiresAt: row.expiresAt } });
    const { tokenHash: _h, ...safe } = row;
    return { ...safe, token: t.token, portalPath: `/supplier-portal/${t.token}` };
  }

  async revoke(user: JwtPayload, tokenId: string) {
    const [t] = await this.db.select().from(supplierAccessTokens).where(eq(supplierAccessTokens.id, tokenId)).limit(1);
    if (!t) throw new NotFoundException();
    const s = await this.supplierFor(user, t.supplierId);
    if (t.revokedAt) throw new ConflictException('Already revoked');
    await this.db.update(supplierAccessTokens).set({ revokedAt: new Date(), revokedById: user.sub }).where(eq(supplierAccessTokens.id, tokenId));
    await this.audit.log({ organizationId: s.organizationId, actorId: user.sub, action: 'supplier.portal_token_revoke', entityType: 'supplier', entityId: s.id, after: { tokenId } });
    return { ok: true };
  }

  private async resolve(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Supplier token required');
    const [t] = await this.db.select().from(supplierAccessTokens).where(eq(supplierAccessTokens.tokenHash, hashToken(token))).limit(1);
    if (!t || t.revokedAt || (t.expiresAt && t.expiresAt < new Date())) throw new UnauthorizedException('This supplier link is invalid, expired or revoked');
    const [s] = await this.db.select().from(suppliers).where(eq(suppliers.id, t.supplierId)).limit(1);
    if (!s) throw new UnauthorizedException();
    await this.db.update(supplierAccessTokens).set({ lastUsedAt: new Date() }).where(eq(supplierAccessTokens.id, t.id));
    return { t, s };
  }

  /** What the portal page shows: this supplier's purchase orders waiting for an invoice, and recent submissions. */
  async portal(token: string | undefined) {
    const { s } = await this.resolve(token);
    const pos = await this.db.select({ po: purchaseOrders, kitchen: kitchens.name }).from(purchaseOrders).innerJoin(kitchens, eq(kitchens.id, purchaseOrders.kitchenId)).where(and(eq(purchaseOrders.supplierId, s.id), inArray(purchaseOrders.status, ['ORDERED', 'RECEIVED']))).orderBy(desc(purchaseOrders.createdAt)).limit(50);
    const lines = pos.length ? await this.db.select({ l: purchaseOrderLines, name: ingredients.name, unit: ingredients.unit, pu: ingredients.purchaseUnit }).from(purchaseOrderLines).innerJoin(ingredients, eq(ingredients.id, purchaseOrderLines.ingredientId)).where(inArray(purchaseOrderLines.purchaseOrderId, pos.map((p) => p.po.id))) : [];
    const subs = await this.db.select().from(supplierInvoiceSubmissions).where(eq(supplierInvoiceSubmissions.supplierId, s.id)).orderBy(desc(supplierInvoiceSubmissions.createdAt)).limit(20);
    return {
      supplier: { id: s.id, name: s.name },
      purchaseOrders: pos.map(({ po, kitchen }) => ({ id: po.id, reference: po.id.slice(0, 8).toUpperCase(), kitchen, status: po.status, createdAt: po.createdAt, receivedAt: po.receivedAt, canInvoice: po.status === 'RECEIVED', invoiceNumber: po.invoiceNumber, matchStatus: po.matchStatus, lines: lines.filter((x) => x.l.purchaseOrderId === po.id).map((x) => ({ ingredientId: x.l.ingredientId, name: x.name, unit: x.pu || x.unit, orderedQty: x.l.quantity, receivedQty: x.l.receivedQty, unitCostCents: x.l.unitCostCents })) })),
      submissions: subs.map((x) => ({ id: x.id, source: x.source, invoiceNumber: x.invoiceNumber, purchaseOrderId: x.purchaseOrderId, status: x.status, totalCents: x.totalCents, error: x.error, createdAt: x.createdAt })),
    };
  }

  /** Portal form submission (ingredient ids). */
  async submit(token: string | undefined, input: { purchaseOrderId: string; invoiceNumber: string; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }) {
    const { t, s } = await this.resolve(token);
    return this.record(t.id, s, 'PORTAL', { poRef: input.purchaseOrderId, invoiceNumber: input.invoiceNumber, lines: input.lines.map((l) => ({ item: l.ingredientId, quantity: l.quantity, unitCostCents: l.unitCostCents })) }, null);
  }

  /** EDI 810 or CSV upload: every invoice in the file is matched separately. */
  async upload(token: string | undefined, format: 'edi810' | 'csv', raw: string) {
    const { t, s } = await this.resolve(token);
    if (!raw?.trim()) throw new BadRequestException('Empty document');
    if (raw.length > 1_000_000) throw new BadRequestException('Document too large (1 MB max)');
    const parsed = format === 'csv' ? parseInvoiceCsv(raw) : parseEdi810(raw);
    const results = [];
    for (const p of parsed) results.push(await this.record(t.id, s, format === 'csv' ? 'CSV' : 'EDI_810', p, raw.slice(0, 20000)));
    return { invoices: results.length, results };
  }

  private async record(tokenId: string, s: typeof suppliers.$inferSelect, source: 'PORTAL' | 'EDI_810' | 'CSV', p: ParsedInvoice, raw: string | null) {
    const base = { supplierId: s.id, tokenId, source, invoiceNumber: p.invoiceNumber || null, raw };
    const reject = async (error: string, poId: string | null = null) => {
      const [row] = await this.db.insert(supplierInvoiceSubmissions).values({ ...base, purchaseOrderId: poId, status: 'REJECTED', error, lines: p.lines }).returning();
      return { submissionId: row.id, invoiceNumber: p.invoiceNumber, purchaseOrderId: poId, status: 'REJECTED' as string, error, matchStatus: null as string | null, varianceCents: null as number | null };
    };
    const ref = (p.poRef || '').trim();
    const pos = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.supplierId, s.id), isNull(purchaseOrders.billPaidAt)));
    const po = UUID.test(ref) ? pos.find((x) => x.id === ref.toLowerCase()) : ref.length >= 8 ? (pos.filter((x) => x.id.toUpperCase().startsWith(ref.toUpperCase())).length === 1 ? pos.find((x) => x.id.toUpperCase().startsWith(ref.toUpperCase())) : undefined) : undefined;
    if (!po) return reject(`Purchase order ${ref || '(missing)'} not found for ${s.name}`);
    if (po.status !== 'RECEIVED') return reject('The goods have not been received yet', po.id);
    if (po.matchStatus === 'MATCHED' && po.invoiceNumber && po.invoiceNumber !== p.invoiceNumber) return reject(`Already matched to invoice ${po.invoiceNumber}`, po.id);
    const poLines = await this.db.select({ l: purchaseOrderLines, name: ingredients.name }).from(purchaseOrderLines).innerJoin(ingredients, eq(ingredients.id, purchaseOrderLines.ingredientId)).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    const lines: { ingredientId: string; quantity: number; unitCostCents: number }[] = [];
    for (const l of p.lines) {
      const hit = poLines.find((x) => x.l.ingredientId === l.item.toLowerCase()) || poLines.find((x) => x.name.trim().toLowerCase() === l.item.trim().toLowerCase());
      if (!hit) return reject(`Line item ${l.item} is not on purchase order ${po.id.slice(0, 8).toUpperCase()}`, po.id);
      if (l.quantity < 0 || l.unitCostCents < 0) return reject(`Negative quantity or price on ${l.item}`, po.id);
      lines.push({ ingredientId: hit.l.ingredientId, quantity: l.quantity, unitCostCents: l.unitCostCents });
    }
    try {
      const u = await this.inv.matchInvoice(po, { invoiceNumber: p.invoiceNumber, lines }, null, `SUPPLIER_${source}`);
      const [row] = await this.db.insert(supplierInvoiceSubmissions).values({ ...base, purchaseOrderId: po.id, status: u.matchStatus || 'VARIANCE', totalCents: u.invoiceTotalCents, lines }).returning();
      await this.audit.log({ organizationId: s.organizationId, actorId: null, action: 'supplier.invoice_submit', entityType: 'purchase_order', entityId: po.id, after: { source, invoiceNumber: p.invoiceNumber, matchStatus: u.matchStatus, submissionId: row.id } });
      return { submissionId: row.id, invoiceNumber: p.invoiceNumber, purchaseOrderId: po.id, status: row.status, error: null, matchStatus: u.matchStatus, varianceCents: (u.matchDetail as { varianceCents?: number } | null)?.varianceCents ?? null };
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      return reject((e as Error).message, po.id);
    }
  }
}
