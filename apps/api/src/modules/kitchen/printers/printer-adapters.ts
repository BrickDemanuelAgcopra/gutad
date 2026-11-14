import { Logger } from '@nestjs/common';
import { createConnection } from 'node:net';

export interface PrinterTarget { id: string; name: string; protocol: string; host: string | null; port: number; width: number }

/** Sends a rendered ticket to a printer. Throws on failure (the queue retries). */
export interface PrinterAdapter {
  readonly name: string;
  send(printer: PrinterTarget, body: string): Promise<void>;
}

const ESC = 0x1b;
const GS = 0x1d;

/** Plain ASCII for thermal printers' default code page. */
export function asciiOnly(s: string) {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/…/g, '...').replace(/·/g, '-').normalize('NFKD').replace(/[^\x0a\x20-\x7e]/g, '');
}

/**
 * ESC/POS encoding of a rendered ticket: lines starting with `# ` print double size and bold, `! ` bold;
 * the job ends with a feed and a partial cut.
 */
export function escPos(body: string): Buffer {
  const out: number[] = [ESC, 0x40]; // initialize
  for (const raw of body.split('\n')) {
    let line = raw;
    let big = false;
    let bold = false;
    if (line.startsWith('# ')) { big = true; line = line.slice(2); }
    else if (line.startsWith('! ')) { bold = true; line = line.slice(2); }
    if (big) out.push(GS, 0x21, 0x11, ESC, 0x45, 0x01);
    else if (bold) out.push(ESC, 0x45, 0x01);
    out.push(...Buffer.from(asciiOnly(line), 'ascii'), 0x0a);
    if (big) out.push(GS, 0x21, 0x00, ESC, 0x45, 0x00);
    else if (bold) out.push(ESC, 0x45, 0x00);
  }
  out.push(ESC, 0x64, 0x04, GS, 0x56, 0x41, 0x03); // feed 4 lines, partial cut
  return Buffer.from(out);
}

/** Default adapter: writes the ticket to the server log. Never opens a socket (safe for tests and pilots). */
export class LogPrinterAdapter implements PrinterAdapter {
  readonly name = 'log';
  private readonly log = new Logger('Printer');
  async send(printer: PrinterTarget, body: string) {
    this.log.log(`[${printer.name}] ${escPos(body).length} bytes\n${asciiOnly(body)}`);
  }
}

/** ESC/POS over raw TCP (JetDirect, port 9100). Used only for printers with protocol RAW_TCP and a host. */
export class RawTcpPrinterAdapter implements PrinterAdapter {
  readonly name = 'raw_tcp';
  constructor(private readonly timeoutMs = 5000) {}
  send(printer: PrinterTarget, body: string) {
    const data = escPos(body);
    return new Promise<void>((resolve, reject) => {
      if (!printer.host) return reject(new Error('Printer has no host'));
      let done = false;
      const finish = (e?: Error) => { if (done) return; done = true; sock.destroy(); if (e) reject(e); else resolve(); };
      const sock = createConnection({ host: printer.host, port: printer.port || 9100 });
      sock.setTimeout(this.timeoutMs, () => finish(new Error(`No answer from ${printer.host}:${printer.port} within ${this.timeoutMs / 1000}s`)));
      sock.on('error', (e) => finish(new Error(`Printer ${printer.host}:${printer.port}: ${e.message}`)));
      sock.on('connect', () => sock.end(data, () => finish()));
    });
  }
}

/** RAW_TCP only when a host is set; everything else goes to the log adapter. */
export function adapterFor(printer: PrinterTarget, adapters: { log: PrinterAdapter; tcp: PrinterAdapter }): PrinterAdapter {
  return printer.protocol === 'RAW_TCP' && printer.host ? adapters.tcp : adapters.log;
}
