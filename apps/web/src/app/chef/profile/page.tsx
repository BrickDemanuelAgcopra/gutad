'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CHEF_CUISINES } from '@gutad/shared';
import { api, uploadFile } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Spinner, Textarea } from '@/components/ui';
import { ChipGroup, FileDrop } from '@/components/form-kit';
import type { ChefMe } from '../page';

export default function ChefProfilePage() {
  const { data, loading, reload } = useApi<ChefMe>('/chef/me');
  const [f, setF] = useState<{ bio: string; cuisines: string[]; languages: string; experienceYears: string; portraitFileId: string | null; portraitUrl: string | null }>({ bio: '', cuisines: [], languages: '', experienceYears: '', portraitFileId: null, portraitUrl: null });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setF({ bio: data.profile.bio || '', cuisines: data.profile.cuisines, languages: data.profile.languages.join(', '), experienceYears: data.profile.experienceYears?.toString() || '', portraitFileId: data.profile.portraitFileId, portraitUrl: data.profile.portraitUrl });
  }, [data]);
  if (loading) return <Spinner />;
  if (!data) return <Alert tone="info">Only approved chefs have a public profile. <Link href="/chefs/apply" className="underline">Apply</Link></Alert>;
  const save = async () => {
    setMsg(null);
    try {
      await api.patch('/chef/me', { bio: f.bio, cuisines: f.cuisines, languages: f.languages.split(',').map((x) => x.trim()).filter(Boolean), experienceYears: f.experienceYears ? Number(f.experienceYears) : null, portraitFileId: f.portraitFileId });
      await reload();
      setMsg({ tone: 'good', text: 'Profile saved' });
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Public profile</h1>
        <Link href={`/chefs/${data.profile.slug}`} className="text-sm underline">View as a customer →</Link>
      </div>
      <Card>
        <div className="space-y-4">
          <FileDrop accept="image/jpeg,image/png,image/webp" label="Portrait" hint="A clear photo of you" busy={busy} previewUrl={f.portraitUrl} onFile={async (file) => {
            setBusy(true);
            try { const fd = new FormData(); fd.append('file', file); const r = await uploadFile<{ id: string; url: string }>('/chef/photos', fd); setF({ ...f, portraitFileId: r.id, portraitUrl: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}${r.url}` }); } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(false); }
          }} />
          <Textarea label="Biography" rows={5} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
          <div><span className="mb-1 block text-xs font-medium text-ink-500">Cuisines</span><ChipGroup name="Cuisines" max={5} values={f.cuisines} onChange={(c) => setF({ ...f, cuisines: c })} options={CHEF_CUISINES.map((c) => ({ value: c, label: c }))} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Languages (comma separated)" value={f.languages} onChange={(e) => setF({ ...f, languages: e.target.value })} />
            <Input label="Years of experience" type="number" min={0} value={f.experienceYears} onChange={(e) => setF({ ...f, experienceYears: e.target.value })} />
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Button onClick={save}>Save profile</Button>
        </div>
      </Card>
    </div>
  );
}
