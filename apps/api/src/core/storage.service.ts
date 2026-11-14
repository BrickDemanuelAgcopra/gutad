import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { loadConfig } from '../config/config';

/** Where uploaded files live. Keys are opaque paths like `courier-docs/<driver>/<uuid>.pdf`. */
export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const safeKey = (key: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.\-]{0,300}$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  return key;
};

/** Local disk (default): STORAGE_DIR or ./storage under the API's working directory. */
export class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir || join(process.cwd(), 'storage')); }
  private path(key: string) {
    const p = resolve(this.root, ...safeKey(key).split('/'));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }
  async get(key: string) { return readFile(this.path(key)); }
  async remove(key: string) { await unlink(this.path(key)).catch(() => undefined); }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** S3-compatible bucket (AWS S3, MinIO, R2 …) with path-style URLs and Signature V4; no SDK dependency. */
export class S3Storage implements StorageDriver {
  readonly name = 's3' as const;
  constructor(private readonly o: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {}

  /** Signed request; `key` null addresses the bucket itself. Returns the response without judging the status. */
  private async request(method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', key: string | null, body?: Buffer, contentType?: string) {
    const endpoint = (this.o.endpoint || `https://s3.${this.o.region}.amazonaws.com`).replace(/\/$/, '');
    const url = new URL(`${endpoint}/${enc(this.o.bucket)}${key === null ? '' : `/${safeKey(key).split('/').map(enc).join('/')}`}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, '', names.map((n) => `${n}:${headers[n].trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${this.o.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.o.secretAccessKey}`, day), this.o.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const { host: _h, ...sendHeaders } = headers;
    return fetch(url, { method, body: body ? new Uint8Array(body) : undefined, headers: { ...sendHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } });
  }

  private async send(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
    const res = await this.request(method, key, body, contentType);
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`storage ${method} ${res.status}`);
    return res;
  }

  /** Creates the bucket when it does not exist yet (self-hosted MinIO starts empty). Private by default. */
  async ensureBucket() {
    const head = await this.request('HEAD', null);
    if (head.ok) return false;
    if (head.status !== 404) throw new Error(`storage bucket check ${head.status}`);
    const res = await this.request('PUT', null);
    if (!res.ok && res.status !== 409) throw new Error(`storage bucket create ${res.status}`);
    return true;
  }

  async put(key: string, body: Buffer, contentType: string) {
    const res = await this.request('PUT', key, body, contentType);
    if (res.status === 404) { await this.ensureBucket(); await this.send('PUT', key, body, contentType); return; }
    if (!res.ok) throw new Error(`storage PUT ${res.status}`);
  }
  async get(key: string) { return Buffer.from(await (await this.send('GET', key)).arrayBuffer()); }
  async remove(key: string) { await this.send('DELETE', key); }
}

/**
 * 16.2-U file storage. Local disk by default; STORAGE_DRIVER=s3 with S3_BUCKET and keys uses an S3-compatible bucket.
 * Files are never public: the API streams them to authorized users.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  readonly driver: StorageDriver;

  constructor() {
    const c = loadConfig();
    if (c.STORAGE_DRIVER === 's3' && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY) {
      const s3 = new S3Storage({ endpoint: c.S3_ENDPOINT, region: c.S3_REGION || 'us-east-1', bucket: c.S3_BUCKET, accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY });
      this.driver = s3;
      // The object store may start after the API; keep trying for a minute, then leave it to the first upload.
      const ready = async (n: number): Promise<void> => {
        try { if (await s3.ensureBucket()) this.log.log(`created storage bucket ${c.S3_BUCKET}`); }
        catch (e) { if (n < 12) { setTimeout(() => void ready(n + 1), 5000).unref(); } else this.log.warn(`storage bucket not reachable: ${(e as Error).message}`); }
      };
      void ready(1);
    } else {
      if (c.STORAGE_DRIVER === 's3') this.log.warn('STORAGE_DRIVER=s3 without S3_BUCKET / keys; using local disk');
      this.driver = new LocalStorage(c.STORAGE_DIR);
    }
  }

  static sha256(b: Buffer) { return sha256(b); }
}
