import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { kitchenTickets, locations, orderLines, orders, packingTasks, printJobs, printers } from '../../db/schema';
import { assertOrgAccess, JwtPayload, MANAGER_ROLES, MERCHANT_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { adapterFor, LogPrinterAdapter, RawTcpPrinterAdapter, type PrinterAdapter } from './printers/printer-adapters';

type Printer = typeof printers.$inferSelect;
type Job = typeof printJobs.$inferSelect;
export interface PrinterInput { name: string; stationCode?: string | null; role?: 'TICKETS' | 'LABELS' | 'BOTH'; protocol?: 'LOG' | 'RAW_TCP'; host?: string | null; port?: number; width?: number; autoPrint?: boolean; isActive?: boolean }

const pad = (a: string, b: string, w: number) => `${a}${' '.repeat(Math.max(1, w - a.length - b.length))}${b}`;
const hm = (d: Date | null | undefined, tz: string) => (d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '');

/**
 * 13.8-P network ticket printers: a registry per location (optionally per station), a print queue for station tickets,
 * bag labels and test pages, with retries (exponential backoff) and a failure status. The default adapter writes to the
 * log; ESC/POS over raw TCP (port 9100) is used only for printers set to RAW_TCP with a host.
 */
@Injectable()
export class PrintingService {
  private readonly log = new Logger(PrintingService.name);
  private readonly adapters: { log: PrinterAdapter; tcp: PrinterAdapter } = { log: new LogPrinterAdapter(), tcp: new RawTcpPrinterAdapter() };

  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly redis: RedisService) {}

  private async requireLoc(user: JwtPayload, locationId: string, roles = MERCHANT_ROLES) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    assertOrgAccess(user, loc.organizationId, loc.id, roles);
    return loc;
  }

  private async requirePrinter(user: JwtPayload, printerId: string, roles = MERCHANT_ROLES) {
    const [p] = await this.db.select().from(printers).where(eq(printers.id, printerId)).limit(1);
    if (!p) throw new NotFoundException('Printer not found');
    const loc = await this.requireLoc(user, p.locationId, roles);
    return { p, loc };
  }

  // ───── registry ─────

  async list(user: JwtPayload, locationId: string) {
    await this.requireLoc(user, locationId);
    return this.db.select().from(printers).where(eq(printers.locationId, locationId)).orderBy(printers.name);
  }

  private validate(input: Partial<PrinterInput>) {
    if (input.protocol === 'RAW_TCP' && input.host !== undefined && input.host !== null && !/^[a-zA-Z0-9.\-:]{1,253}$/.test(input.host)) throw new BadRequestException('Enter the printer’s IP address or host name');
    if (input.port !== undefined && (input.port < 1 || input.port > 65535)) throw new BadRequestException('Port must be 1–65535');
  }

  async create(user: JwtPayload, locationId: string, input: PrinterInput) {
    const loc = await this.requireLoc(user, locationId, MANAGER_ROLES);
    this.validate(input);
    const [p] = await this.db.insert(printers).values({ locationId, name: input.name, stationCode: input.stationCode ? input.stationCode.toUpperCase() : null, role: input.role ?? 'TICKETS', protocol: input.protocol ?? 'LOG', host: input.host || null, port: input.port ?? 9100, width: input.width ?? 42, autoPrint: input.autoPrint ?? false, isActive: input.isActive ?? true }).returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'printer.create', entityType: 'printer', entityId: p.id, after: p });
    return p;
  }

  async update(user: JwtPayload, printerId: string, input: Partial<PrinterInput>) {
    const { p, loc } = await this.requirePrinter(user, printerId, MANAGER_ROLES);
    this.validate({ protocol: input.protocol ?? (p.protocol as 'LOG' | 'RAW_TCP'), ...input });
    const set: Partial<typeof printers.$inferInsert> = {};
    for (const k of ['name', 'role', 'protocol', 'port', 'width', 'autoPrint', 'isActive'] as const) if (input[k] !== undefined) (set as Record<string, unknown>)[k] = input[k];
    if (input.stationCode !== undefined) set.stationCode = input.stationCode ? input.stationCode.toUpperCase() : null;
    if (input.host !== undefined) set.host = input.host || null;
    const [u] = await this.db.update(printers).set(set).where(eq(printers.id, printerId)).returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'printer.update', entityType: 'printer', entityId: printerId, before: p, after: set });
    return u;
  }

  async remove(user: JwtPayload, printerId: string) {
    const { loc } = await this.requirePrinter(user, printerId, MANAGER_ROLES);
    await this.db.delete(printers).where(eq(printers.id, printerId));
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'printer.delete', entityType: 'printer', entityId: printerId });
    return { ok: true };
  }

  async jobs(user: JwtPayload, locationId: string, status?: string) {
    await this.requireLoc(user, locationId);
    const rows = await this.db.select().from(printJobs).where(and(eq(printJobs.locationId, locationId), status ? inArray(printJobs.status, status.split(',')) : undefined)).orderBy(desc(printJobs.createdAt)).limit(100);
    return rows.map(({ body: _b, ...r }) => ({ ...r, preview: _b.split('\n').slice(0, 6).join('\n') }));
  }

  // ───── rendering ─────

  private async renderTickets(ticketIds: string[], tx: DbOrTx) {
    if (!ticketIds.length) return [];
    const ts = await tx.select({ t: kitchenTickets, o: orders }).from(kitchenTickets).innerJoin(orders, eq(orders.id, kitchenTickets.orderId)).where(inArray(kitchenTickets.id, ticketIds));
    const lineIds = ts.flatMap((x) => x.t.lineIds);
    const lines = lineIds.length ? await tx.select().from(orderLines).where(inArray(orderLines.id, lineIds)) : [];
    const locIds = Array.from(new Set(ts.map((x) => x.o.locationId)));
    const locs = await tx.select({ id: locations.id, name: locations.name, timezone: locations.timezone }).from(locations).where(inArray(locations.id, locIds));
    return ts.map(({ t, o }) => {
      const loc = locs.find((l) => l.id === o.locationId)!;
      const ls = lines.filter((l) => t.lineIds.includes(l.id));
      const out = [`# ${t.stationCode || 'MAIN'}${t.kind === 'REMAKE' ? ' REMAKE' : ''}`, `# #${o.number}`, `! ${o.fulfillmentType.replace('_', '-')}${o.tableNumber ? ` - TABLE ${o.tableNumber}` : ''}${o.guestName ? ` - ${o.guestName.split(' ')[0]}` : ''}`, `${loc.name}`, `Fire ${hm(t.fireAt, loc.timezone)}  Ready by ${hm(t.readyBy, loc.timezone)}`, '-'.repeat(32)];
      for (const l of ls) {
        out.push(`! ${l.quantity} x ${l.name}`);
        for (const m of (l.modifiers as { name: string }[]) || []) out.push(`    + ${m.name}`);
        if (l.specialInstructions) out.push(`    NOTE: ${l.specialInstructions}`);
        if (l.handling.includes('ALLERGEN')) out.push('! *** ALLERGY ***');
      }
      if (o.specialInstructions) out.push('-'.repeat(32), `Order note: ${o.specialInstructions}`);
      return { ticket: t, order: o, title: `${t.stationCode || 'MAIN'} ticket #${o.number}`, body: out.join('\n') };
    });
  }

  private async renderLabels(packingTaskId: string, tx: DbOrTx) {
    const [x] = await tx.select({ p: packingTasks, o: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(eq(packingTasks.id, packingTaskId)).limit(1);
    if (!x) throw new NotFoundException('Packing task not found');
    const [loc] = await tx.select({ name: locations.name, timezone: locations.timezone, organizationId: locations.organizationId, id: locations.id }).from(locations).where(eq(locations.id, x.o.locationId)).limit(1);
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, x.o.id));
    const bags = (x.p.bags as { n: number; code: string; handling: string[] }[]).length ? (x.p.bags as { n: number; code: string; handling: string[] }[]) : [{ n: 1, code: x.p.bagCode, handling: x.p.handling }];
    const allergy = lines.filter((l) => l.handling.includes('ALLERGEN')).map((l) => `${l.name}${l.specialInstructions ? `: ${l.specialInstructions}` : ''}`);
    const items = lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status));
    // 14.2 no pickup code is printed on a label
    const bodies = bags.map((b) => [`# #${x.o.number}`, `! Bag ${b.n} of ${x.p.bagCount || bags.length}  ${b.code}`, `${x.o.fulfillmentType.replace('_', '-')}${x.o.guestName ? ` - ${x.o.guestName.split(' ')[0]}` : ''}${x.o.tableNumber ? ` - TABLE ${x.o.tableNumber}` : ''}${x.o.shelfSlot ? ` - SHELF ${x.o.shelfSlot}` : ''}`, `${loc.name}  ${hm(x.o.promiseAt, loc.timezone)}`, ...(b.handling.length ? [`! ${b.handling.join(' / ')}`] : []), '-'.repeat(24), ...items.map((l) => `${l.quantity} x ${l.name}`), ...(allergy.length ? ['! *** ALLERGY ***', ...allergy] : [])].join('\n'));
    return { task: x.p, order: x.o, loc, bodies };
  }

  // ───── queue ─────

  private matchTicket(p: Printer, stationCode: string | null) {
    return p.isActive && (p.role === 'TICKETS' || p.role === 'BOTH') && (!p.stationCode || p.stationCode === (stationCode || 'MAIN'));
  }

  /** Called inside the acceptance transaction after fan-out: queue tickets for printers with auto-print on. */
  async queueForTickets(tickets: { id: string; orderId: string; stationCode: string | null }[], tx: DbOrTx) {
    if (!tickets.length) return 0;
    const [o] = await tx.select({ locationId: orders.locationId }).from(orders).where(eq(orders.id, tickets[0].orderId)).limit(1);
    if (!o) return 0;
    const ps = (await tx.select().from(printers).where(and(eq(printers.locationId, o.locationId), eq(printers.autoPrint, true), eq(printers.isActive, true))));
    if (!ps.length) return 0;
    const rendered = await this.renderTickets(tickets.map((t) => t.id), tx);
    const values = rendered.flatMap((r) => ps.filter((p) => this.matchTicket(p, r.ticket.stationCode)).map((p) => ({ printerId: p.id, locationId: o.locationId, kind: 'STATION_TICKET', refId: r.ticket.id, orderId: r.order.id, title: r.title, body: r.body })));
    if (values.length) await tx.insert(printJobs).values(values);
    return values.length;
  }

  private async enqueueAndSend(values: (typeof printJobs.$inferInsert)[]) {
    if (!values.length) throw new BadRequestException({ message: 'No active printer for this — add one in Settings → Capacity, printers & kiosk', code: 'NO_PRINTER' });
    const jobs = await this.db.insert(printJobs).values(values).returning();
    const out: Job[] = [];
    for (const j of jobs) out.push(await this.process(j.id));
    return out;
  }

  async printTicket(user: JwtPayload, ticketId: string, printerId?: string) {
    const [t] = await this.db.select({ t: kitchenTickets, o: orders }).from(kitchenTickets).innerJoin(orders, eq(orders.id, kitchenTickets.orderId)).where(eq(kitchenTickets.id, ticketId)).limit(1);
    if (!t) throw new NotFoundException('Ticket not found');
    await this.requireLoc(user, t.o.locationId);
    return this.printTicketsFor(user, t.o.locationId, [ticketId], printerId);
  }

  /** Print every station ticket of an order (independent restaurants print from the order inbox). */
  async printOrder(user: JwtPayload, orderId: string, printerId?: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException('Order not found');
    await this.requireLoc(user, o.locationId);
    const ts = await this.db.select({ id: kitchenTickets.id }).from(kitchenTickets).where(and(eq(kitchenTickets.orderId, orderId), inArray(kitchenTickets.status, ['QUEUED', 'IN_PROGRESS', 'DONE'])));
    if (!ts.length) throw new BadRequestException({ message: 'This order has no kitchen tickets yet (accept it first)', code: 'NO_TICKETS' });
    return this.printTicketsFor(user, o.locationId, ts.map((t) => t.id), printerId);
  }

  private async printTicketsFor(user: JwtPayload, locationId: string, ticketIds: string[], printerId?: string) {
    const ps = await this.db.select().from(printers).where(eq(printers.locationId, locationId));
    const rendered = await this.renderTickets(ticketIds, this.db);
    const values = rendered.flatMap((r) => {
      const targets = printerId ? ps.filter((p) => p.id === printerId) : ps.filter((p) => this.matchTicket(p, r.ticket.stationCode));
      return targets.map((p) => ({ printerId: p.id, locationId, kind: 'STATION_TICKET', refId: r.ticket.id, orderId: r.order.id, title: r.title, body: r.body, requestedById: user.sub }));
    });
    if (printerId && !ps.some((p) => p.id === printerId)) throw new NotFoundException('Printer not found at this location');
    return this.enqueueAndSend(values);
  }

  async printLabels(user: JwtPayload, packingTaskId: string, printerId?: string) {
    const r = await this.renderLabels(packingTaskId, this.db);
    assertOrgAccess(user, r.loc.organizationId, r.loc.id, MERCHANT_ROLES);
    const ps = await this.db.select().from(printers).where(eq(printers.locationId, r.loc.id));
    if (printerId && !ps.some((p) => p.id === printerId)) throw new NotFoundException('Printer not found at this location');
    const targets = printerId ? ps.filter((p) => p.id === printerId) : ps.filter((p) => p.isActive && (p.role === 'LABELS' || p.role === 'BOTH')).slice(0, 1);
    return this.enqueueAndSend(targets.flatMap((p) => r.bodies.map((body, i) => ({ printerId: p.id, locationId: r.loc.id, kind: 'BAG_LABEL', refId: r.task.id, orderId: r.order.id, title: `Bag ${i + 1} label #${r.order.number}`, body, requestedById: user.sub }))));
  }

  async test(user: JwtPayload, printerId: string) {
    const { p, loc } = await this.requirePrinter(user, printerId);
    const now = new Date();
    const body = [`# TEST PRINT`, `! ${p.name}`, `${loc.name}`, `Station: ${p.stationCode || 'all'}  Role: ${p.role.toLowerCase()}`, `Connection: ${p.protocol === 'RAW_TCP' && p.host ? `${p.host}:${p.port}` : 'log (no network)'}`, `${now.toISOString()}`, '-'.repeat(Math.min(p.width, 48)), pad('Left', 'Right', Math.min(p.width, 48))].join('\n');
    const [j] = await this.enqueueAndSend([{ printerId: p.id, locationId: loc.id, kind: 'TEST', title: `Test page ${p.name}`, body, requestedById: user.sub }]);
    return j;
  }

  async retry(user: JwtPayload, jobId: string) {
    const [j] = await this.db.select().from(printJobs).where(eq(printJobs.id, jobId)).limit(1);
    if (!j) throw new NotFoundException('Print job not found');
    await this.requireLoc(user, j.locationId);
    if (j.status === 'PRINTED') return j;
    await this.db.update(printJobs).set({ status: 'QUEUED', attempts: 0, lastError: null, nextAttemptAt: null }).where(eq(printJobs.id, jobId));
    return this.process(jobId);
  }

  /** Send one job. Failures back off (15 s, 30 s, 60 s …) until maxAttempts, then the job is FAILED. A turned-off printer fails at once. */
  async process(jobId: string): Promise<Job> {
    const [claimed] = await this.db.update(printJobs).set({ status: 'PRINTING' }).where(and(eq(printJobs.id, jobId), eq(printJobs.status, 'QUEUED'))).returning();
    if (!claimed) return (await this.db.select().from(printJobs).where(eq(printJobs.id, jobId)))[0];
    const [p] = await this.db.select().from(printers).where(eq(printers.id, claimed.printerId)).limit(1);
    const attempts = claimed.attempts + 1;
    if (!p || !p.isActive) {
      const [u] = await this.db.update(printJobs).set({ status: 'FAILED', attempts, lastError: 'Printer is turned off', nextAttemptAt: null }).where(eq(printJobs.id, jobId)).returning();
      return u;
    }
    try {
      await adapterFor(p, this.adapters).send(p, claimed.body);
      const now = new Date();
      await this.db.update(printers).set({ lastStatus: 'OK', lastError: null, lastPrintedAt: now }).where(eq(printers.id, p.id));
      if (claimed.kind === 'STATION_TICKET' && claimed.refId) await this.db.update(kitchenTickets).set({ printedAt: now }).where(and(eq(kitchenTickets.id, claimed.refId), isNull(kitchenTickets.printedAt)));
      const [u] = await this.db.update(printJobs).set({ status: 'PRINTED', attempts, printedAt: now, lastError: null, nextAttemptAt: null }).where(eq(printJobs.id, jobId)).returning();
      return u;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await this.db.update(printers).set({ lastStatus: 'ERROR', lastError: msg }).where(eq(printers.id, p.id));
      const final = attempts >= claimed.maxAttempts;
      const [u] = await this.db.update(printJobs).set({ status: final ? 'FAILED' : 'QUEUED', attempts, lastError: msg, nextAttemptAt: final ? null : new Date(Date.now() + 15_000 * 2 ** (attempts - 1)) }).where(eq(printJobs.id, jobId)).returning();
      if (final) this.log.warn(`print job ${jobId} failed after ${attempts} attempts: ${msg}`);
      return u;
    }
  }

  /** Worker: send queued jobs that are due (auto-printed tickets and retries). */
  async processDue(limit = 50) {
    const due = await this.db.select({ id: printJobs.id }).from(printJobs).where(and(eq(printJobs.status, 'QUEUED'), or(isNull(printJobs.nextAttemptAt), lte(printJobs.nextAttemptAt, new Date())))).orderBy(printJobs.createdAt).limit(limit);
    let printed = 0;
    let failed = 0;
    for (const d of due) {
      const r = await this.process(d.id);
      if (r?.status === 'PRINTED') printed++;
      else if (r?.status === 'FAILED') failed++;
    }
    return { due: due.length, printed, failed };
  }

  /** Runs only in the worker (the scheduler is not loaded in the API process). */
  @Interval(10_000) async printQueueJob() {
    const release = await this.redis.lock('job:print-queue', 30_000).catch(() => null);
    if (!release) return;
    try { await this.processDue(); } catch (e) { this.log.warn(`print queue: ${(e as Error).message}`); } finally { await release(); }
  }
}
