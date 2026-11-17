import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { storedFiles } from '../../db/schema';
import { can, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { StorageService } from '../../core/storage.service';
import { loadConfig } from '../../config/config';

export const MAX_CHEF_FILE_BYTES = 10 * 1024 * 1024;
const DOC_MIME: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const PHOTO_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface IncomingFile { originalname: string; mimetype: string; size: number; buffer: Buffer }

function looksLike(mime: string, b: Buffer) {
  if (mime === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return b.subarray(4, 8).toString('latin1') === 'ftyp';
}

/**
 * Chef Network files in object storage: CHEF_DOCUMENT (private: the uploader and chef reviewers, audited)
 * and CHEF_PHOTO (portraits, portfolio and dish photos; public once referenced by a profile or dish).
 */
@Injectable()
export class ChefFilesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService) {}

  async store(user: JwtPayload, file: IncomingFile | undefined, purpose: 'CHEF_DOCUMENT' | 'CHEF_PHOTO') {
    if (!file || !file.size) throw new BadRequestException('Choose a file to upload');
    const allowed = purpose === 'CHEF_PHOTO' ? PHOTO_MIME : DOC_MIME;
    const ext = allowed[file.mimetype];
    if (!ext) throw new BadRequestException(purpose === 'CHEF_PHOTO' ? 'Upload a JPG, PNG or WEBP photo' : 'Upload a PDF or a photo (JPG, PNG, WEBP, HEIC)');
    if (file.size > MAX_CHEF_FILE_BYTES) throw new BadRequestException('Files can be up to 10 MB');
    if (!looksLike(file.mimetype, file.buffer)) throw new BadRequestException('The file does not match its type; upload the original file');
    const key = `${purpose === 'CHEF_PHOTO' ? 'chef-photos' : 'chef-docs'}/${user.sub}/${randomUUID()}.${ext}`;
    await this.storage.driver.put(key, file.buffer, file.mimetype);
    const [f] = await this.db
      .insert(storedFiles)
      .values({ purpose, driver: this.storage.driver.name, storageKey: key, fileName: (file.originalname || `file.${ext}`).slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, sha256: StorageService.sha256(file.buffer), ownerUserId: user.sub })
      .returning();
    return f;
  }

  async row(fileId: string) {
    const [f] = await this.db.select().from(storedFiles).where(eq(storedFiles.id, fileId)).limit(1);
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  /** Private read: the uploader or chef reviewers (staff views are audited). */
  async read(user: JwtPayload, fileId: string) {
    const f = await this.row(fileId);
    if (!f.purpose.startsWith('CHEF_')) throw new NotFoundException('File not found');
    const own = f.ownerUserId === user.sub;
    const staff = isPlatformStaff(user) && can(user, 'chefs.read');
    if (!own && !staff) throw new ForbiddenException('No access to this file');
    if (!own) await this.audit.log({ actorId: user.sub, action: 'file.view', entityType: 'stored_file', entityId: f.id, after: { purpose: f.purpose } });
    return this.content(f);
  }

  private sign(fileId: string, exp: number) {
    return createHmac('sha256', `chef-file-link:${loadConfig().JWT_SECRET}`).update(`${fileId}.${exp}`).digest('base64url');
  }

  /** A 5-minute link for apps that open files in a browser (checked and audited like a view). */
  async link(user: JwtPayload, fileId: string) {
    const f = await this.row(fileId);
    if (!f.purpose.startsWith('CHEF_')) throw new NotFoundException('File not found');
    const own = f.ownerUserId === user.sub;
    if (!own && !(isPlatformStaff(user) && can(user, 'chefs.read'))) throw new ForbiddenException('No access to this file');
    if (!own) await this.audit.log({ actorId: user.sub, action: 'file.view', entityType: 'stored_file', entityId: f.id, after: { purpose: f.purpose, via: 'link' } });
    const exp = Math.floor(Date.now() / 1000) + 300;
    return { url: `${loadConfig().PUBLIC_API_URL.replace(/\/$/, '')}/public/chef-files/${fileId}/signed?exp=${exp}&sig=${this.sign(fileId, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async readSigned(fileId: string, exp: string, sig: string) {
    const e = Number(exp);
    const want = Buffer.from(this.sign(fileId, e));
    const got = Buffer.from(String(sig || ''));
    if (!e || e * 1000 < Date.now() || want.length !== got.length || !timingSafeEqual(want, got)) throw new ForbiddenException('This link has expired; open the file again');
    const f = await this.row(fileId);
    if (!f.purpose.startsWith('CHEF_')) throw new NotFoundException('File not found');
    return this.content(f);
  }

  /** Public read for photos only (documents never). */
  async readPhoto(fileId: string) {
    const f = await this.row(fileId);
    if (f.purpose !== 'CHEF_PHOTO') throw new NotFoundException('File not found');
    return this.content(f);
  }

  async assertOwnPhoto(user: JwtPayload, fileId: string | undefined | null) {
    if (!fileId) return;
    const f = await this.row(fileId).catch(() => null);
    if (!f || f.purpose !== 'CHEF_PHOTO' || (f.ownerUserId !== user.sub && !isPlatformStaff(user))) throw new BadRequestException('Upload the photo again');
  }

  private async content(f: typeof storedFiles.$inferSelect) {
    const content = await this.storage.driver.get(f.storageKey).catch(() => { throw new NotFoundException('The file is missing from storage'); });
    return { fileName: f.fileName, mimeType: f.mimeType, content };
  }
}

export const chefPhotoUrl = (fileId: string | null | undefined) => (fileId ? `${loadConfig().PUBLIC_API_URL.replace(/\/$/, '')}/public/chef-photos/${fileId}` : null);
