import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config/config';

/** AES-256-GCM for integration credentials at rest; HMAC helpers for webhook signatures. */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    const cfg = loadConfig();
    const material = cfg.CREDENTIALS_KEY || cfg.JWT_SECRET;
    this.key = createHash('sha256').update(material).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }

  decrypt(blob: string): string {
    const [v, iv, tag, data] = blob.split('.');
    if (v !== 'v1') throw new Error('Unknown ciphertext version');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptObject(obj: Record<string, unknown>): Record<string, unknown> {
    return { __enc: this.encrypt(JSON.stringify(obj)) };
  }

  decryptObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (obj && typeof obj.__enc === 'string') return JSON.parse(this.decrypt(obj.__enc));
    return obj;
  }

  hmacSha256(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  verifyHmac(secret: string, payload: string, signature: string): boolean {
    const expected = Buffer.from(this.hmacSha256(secret, payload));
    const given = Buffer.from(signature || '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }
}
