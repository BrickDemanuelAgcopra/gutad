import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { COURIER_DOC_KINDS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { courierDocuments, storedFiles } from '../../db/schema';
import { can, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { StorageService } from '../../core/storage.service';
import { loadConfig } from '../../config/config';
import { DeliveryService } from './delivery.service';

export const MAX_COURIER_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

export interface IncomingFile { originalname: string; mimetype: string; size: number; buffer: Buffer }

/** Magic numbers, so a renamed executable is not stored as a "PDF". */
function looksLike(mime: string, b: Buffer) {
  if (mime === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return b.subarray(4, 8).toString('latin1') === 'ftyp'; // heic / heif
}

/** 16.2-U courier documents uploaded straight to storage (local disk or S3-compatible) and served only to the courier and delivery staff. */
@Injectable()
export class CourierFilesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly storage: StorageService, private readonly delivery: DeliveryService, private readonly audit: AuditService) {}

  async upload(user: JwtPayload, file: IncomingFile | undefined, input: { kind: string; expiresAt?: string }) {
    const d = await this.delivery.myDriver(user);
    if (!file || !file.size) throw new BadRequestException('Choose a file to upload');
    if (!(COURIER_DOC_KINDS as readonly string[]).includes(input.kind)) throw new BadRequestException('Unknown document type');
    if (input.expiresAt && new Date(input.expiresAt) < new Date()) throw new BadRequestException('This document has already expired');
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) throw new BadRequestException('Upload a PDF or a photo (JPG, PNG, WEBP, HEIC)');
    if (file.size > MAX_COURIER_FILE_BYTES) throw new BadRequestException('Files can be up to 10 MB');
    if (!looksLike(file.mimetype, file.buffer)) throw new BadRequestException('The file does not match its type; upload the original PDF or photo');
    const key = `courier-docs/${d.id}/${randomUUID()}.${ext}`;
    await this.storage.driver.put(key, file.buffer, file.mimetype);
    const [f] = await this.db.insert(storedFiles).values({ purpose: 'COURIER_DOCUMENT', driver: this.storage.driver.name, storageKey: key, fileName: (file.originalname || `document.${ext}`).slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, sha256: StorageService.sha256(file.buffer), ownerUserId: user.sub, driverId: d.id }).returning();
    const [doc] = await this.db.insert(courierDocuments).values({ driverId: d.id, kind: input.kind, fileUrl: `/files/${f.id}`, fileId: f.id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }).returning();
    await this.audit.log({ actorId: user.sub, action: 'courier.document_upload', entityType: 'courier_document', entityId: doc.id, after: { kind: input.kind, fileId: f.id, sizeBytes: f.sizeBytes, mimeType: f.mimeType } });
    return { ...doc, file: { id: f.id, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes } };
  }

  /** The uploader, or delivery staff (every staff view is audited). */
  async read(user: JwtPayload, fileId: string) {
    const f = await this.authorize(user, fileId);
    return this.content(f);
  }

  private async authorize(user: JwtPayload, fileId: string) {
    const [f] = await this.db.select().from(storedFiles).where(eq(storedFiles.id, fileId)).limit(1);
    if (!f) throw new NotFoundException('File not found');
    const own = f.ownerUserId === user.sub;
    const staff = isPlatformStaff(user) && (can(user, 'delivery.read') || can(user, 'delivery.manage'));
    if (!own && !staff) throw new ForbiddenException('No access to this file');
    if (!own) await this.audit.log({ actorId: user.sub, action: 'file.view', entityType: 'stored_file', entityId: f.id, after: { purpose: f.purpose, driverId: f.driverId } });
    return f;
  }

  private async content(f: typeof storedFiles.$inferSelect) {
    const content = await this.storage.driver.get(f.storageKey).catch(() => { throw new NotFoundException('The file is missing from storage'); });
    return { fileName: f.fileName, mimeType: f.mimeType, content };
  }

  private sign(fileId: string, exp: number) {
    return createHmac('sha256', `file-link:${loadConfig().JWT_SECRET}`).update(`${fileId}.${exp}`).digest('base64url');
  }

  /** A 5-minute link for apps that open files in a browser (no Authorization header there); checked and audited like a view. */
  async link(user: JwtPayload, fileId: string) {
    await this.authorize(user, fileId);
    const exp = Math.floor(Date.now() / 1000) + 300;
    return { url: `${loadConfig().PUBLIC_API_URL}/files/${fileId}/signed?exp=${exp}&sig=${this.sign(fileId, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async readSigned(fileId: string, exp: string, sig: string) {
    const e = Number(exp);
    const want = Buffer.from(this.sign(fileId, e));
    const got = Buffer.from(String(sig || ''));
    if (!e || e * 1000 < Date.now() || want.length !== got.length || !timingSafeEqual(want, got)) throw new ForbiddenException('This link has expired; open the file again');
    const [f] = await this.db.select().from(storedFiles).where(eq(storedFiles.id, fileId)).limit(1);
    if (!f) throw new NotFoundException('File not found');
    return this.content(f);
  }
}
