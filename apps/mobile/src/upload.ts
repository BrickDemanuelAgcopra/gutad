import { Platform } from 'react-native';
import { API_URL, session } from './api';

export interface PickedFile { name: string; type: string; uri?: string; blob?: Blob }

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
export const mimeFor = (name: string) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

/** Web build: the browser's file chooser. Native builds pass a file URI from the share sheet / files app instead. */
export function pickFileOnWeb(accept = 'application/pdf,image/*'): Promise<PickedFile | null> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => { const f = input.files?.[0]; resolve(f ? { name: f.name, type: f.type || mimeFor(f.name), blob: f } : null); };
    input.click();
  });
}

/** Multipart upload with the session token (React Native's fetch sends `{ uri, name, type }` parts natively). */
export async function uploadMultipart<T>(path: string, file: PickedFile, fields: Record<string, string | undefined>): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, v);
  if (file.blob) fd.append('file', file.blob, file.name);
  else fd.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  const token = await session.token();
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: unknown }).message || `Upload failed (${res.status})`));
  return body as T;
}
