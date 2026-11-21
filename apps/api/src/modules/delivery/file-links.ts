import { createHmac } from 'node:crypto';
import { loadConfig } from '../../config/config';

/** HMAC for a short-lived file link; apps and <img> tags cannot send an Authorization header. */
export function signFile(fileId: string, exp: number) {
  return createHmac('sha256', `file-link:${loadConfig().JWT_SECRET}`).update(`${fileId}.${exp}`).digest('base64url');
}

const STORED = /^\/files\/([0-9a-f-]{36})$/i;

/** The stored-file id behind a `/files/<id>` reference, or null for an external URL. */
export const storedFileId = (url?: string | null) => (url ? STORED.exec(url)?.[1] ?? null : null);

/** Turn a `/files/<id>` reference into a signed absolute link (default 5 minutes); external URLs pass through. Callers authorize first. */
export function viewableUrl(url: string | null | undefined, ttlSeconds = 300) {
  const id = storedFileId(url);
  if (!id) return url ?? null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${loadConfig().PUBLIC_API_URL}/files/${id}/signed?exp=${exp}&sig=${signFile(id, exp)}`;
}
