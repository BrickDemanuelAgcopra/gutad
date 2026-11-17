import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { C } from './ui';
import { pickFileOnWeb, type PickedFile } from './upload';

/** Photo from the camera or library (native), or the browser file chooser (web). */
export async function pickImage(source: 'camera' | 'library'): Promise<PickedFile | null> {
  if (Platform.OS === 'web') return pickFileOnWeb('image/jpeg,image/png,image/webp');
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error(source === 'camera' ? 'Allow camera access in Settings to take a photo' : 'Allow photo access in Settings to choose a photo');
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsEditing: false };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  const type = a.mimeType && ['image/jpeg', 'image/png', 'image/webp'].includes(a.mimeType) ? a.mimeType : 'image/jpeg';
  return { uri: a.uri, name: a.fileName || `photo.${type.split('/')[1]}`, type };
}

/** Selectable chips (multi-select). */
export function Chips<T extends string | number>({ values, options, onChange, max }: { values: T[]; options: { value: T; label: string }[]; onChange: (v: T[]) => void; max?: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {options.map((o) => {
        const on = values.includes(o.value);
        const disabled = !on && !!max && values.length >= max;
        return (
          <Pressable key={String(o.value)} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: on ? C.brand : C.white, borderWidth: 1, borderColor: on ? C.brand : C.ink1, opacity: disabled ? 0.4 : 1 }}>
            <Text style={{ color: on ? C.white : C.ink7, fontSize: 13, fontWeight: '600' }}>{on ? '✓ ' : ''}{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Single-choice cards. */
export function Choice<T extends string>({ value, options, onChange }: { value: T | undefined; options: { value: T; label: string; description?: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: 6, marginBottom: 8 }}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)} style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: on ? C.brand : C.ink1, backgroundColor: on ? '#fff4ec' : C.white }}>
            <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: on ? C.brand : C.ink3, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>{on && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.brand }} />}</View>
            <View style={{ flex: 1 }}><Text style={{ fontWeight: '600', color: C.ink }}>{o.label}</Text>{o.description && <Text style={{ color: C.ink5, fontSize: 12 }}>{o.description}</Text>}</View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Toggle({ on, onChange, title, text }: { on: boolean; onChange: (v: boolean) => void; title: string; text?: string }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} onPress={() => onChange(!on)} style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: on ? C.brand : C.ink1, backgroundColor: on ? '#fff4ec' : C.white, marginBottom: 6 }}>
      <View style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: on ? C.brand : C.ink3, padding: 2, justifyContent: 'center' }}><View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: C.white, marginLeft: on ? 16 : 0 }} /></View>
      <View style={{ flex: 1 }}><Text style={{ fontWeight: '600', color: C.ink }}>{title}</Text>{text && <Text style={{ color: C.ink5, fontSize: 12 }}>{text}</Text>}</View>
    </Pressable>
  );
}

export function Progress({ percent }: { percent: number }) {
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: C.ink1, overflow: 'hidden', marginVertical: 6 }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}>
      <View style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: '100%', backgroundColor: C.brand }} />
    </View>
  );
}

/** Debounced autosave (same contract as the web hook). */
export function useAutosave<T>(save: (v: T) => Promise<unknown>, delay = 800) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ v: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState('saving');
    try { await saveRef.current(p.v); setState('saved'); setError(null); } catch (e) { setState('error'); setError((e as Error).message); }
  }, []);
  const queue = useCallback((v: T) => { pending.current = { v }; setState('saving'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), delay); }, [delay, flush]);
  useEffect(() => () => { void flush(); }, [flush]);
  return { state, error, queue, flush };
}
