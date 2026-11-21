import { useEffect, useState } from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { api } from '../api';
import { pickImage } from '../chef-ui';
import { uploadMultipart } from '../upload';
import { Button, C } from '../ui';

export type PhotoPurpose = 'HANDOFF' | 'SAFE_PLACE' | 'PROFILE' | 'EQUIPMENT' | 'ISSUE';
export interface UploadedPhoto { id: string; url: string; previewUrl: string | null }

/** Camera first (library as a fallback); the photo is uploaded privately and the `/files/<id>` reference handed back. */
export function PhotoCapture({ purpose, label = 'Take photo', value, onChange, library = true }: { purpose: PhotoPurpose; label?: string; value: UploadedPhoto | null; onChange: (p: UploadedPhoto | null) => void; library?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = async (source: 'camera' | 'library') => {
    setError(null);
    try {
      const f = await pickImage(source);
      if (!f) return;
      setBusy(true);
      onChange(await uploadMultipart<UploadedPhoto>('/driver/photos', f, { purpose }));
    } catch (e) {
      setError((e as Error).message === 'Network request failed' ? 'No connection: the photo could not be sent. Try again, or use the PIN or a signature.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 6, marginVertical: 4 }}>
      {value?.previewUrl ? <Image source={{ uri: value.previewUrl }} style={{ width: 96, height: 96, borderRadius: 8 }} /> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Button title={busy ? 'Uploading…' : value ? 'Retake photo' : label} variant="secondary" disabled={busy} onPress={() => void take('camera')} />
        {library && Platform.OS !== 'web' && <Button title="From library" variant="ghost" disabled={busy} onPress={() => void take('library')} />}
        {value && !busy && <Button title="Remove" variant="ghost" onPress={() => onChange(null)} />}
      </View>
      {error ? <Text style={{ color: C.bad, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

/** A stored `/files/<id>` photo through a short-lived link; external links shown as they are. */
export function StoredPhoto({ url, size = 80 }: { url?: string | null; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const m = url ? /^\/files\/([0-9a-f-]{36})$/i.exec(url) : null;
    if (!m) { setSrc(url || null); return; }
    let live = true;
    api.get<{ url: string }>(`/files/${m[1]}/link`).then((r) => { if (live) setSrc(r.url); }).catch(() => undefined);
    return () => { live = false; };
  }, [url]);
  return src ? <Image source={{ uri: src }} style={{ width: size, height: size, borderRadius: 8 }} /> : null;
}
