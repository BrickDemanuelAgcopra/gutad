import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';

export const C = { brand: '#f45d0a', brandDark: '#d94a05', ink: '#141210', ink7: '#3a3632', ink5: '#6b655f', ink3: '#b5aea6', ink1: '#efeae4', bg: '#faf7f3', white: '#fff', good: '#059669', warn: '#d97706', bad: '#dc2626', info: '#0284c7' };

export function Button({ title, onPress, variant = 'primary', disabled, style }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; style?: ViewStyle }) {
  const bg = variant === 'primary' ? C.brand : variant === 'danger' ? C.bad : variant === 'secondary' ? C.white : 'transparent';
  const color = variant === 'primary' || variant === 'danger' ? C.white : C.ink;
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: C.ink1, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}>
      <Text style={{ color, fontWeight: '600', fontSize: 14 }}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, title, style }: { children: ReactNode; title?: string; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {title && <Text style={s.cardTitle}>{title}</Text>}
      {children}
    </View>
  );
}

export function Input({ label, ...rest }: TextInputProps & { label?: string }) {
  return (
    <View style={{ marginBottom: 8 }}>
      {label && <Text style={s.label}>{label}</Text>}
      <TextInput placeholderTextColor={C.ink3} style={s.input} {...rest} />
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const bg = { neutral: C.ink1, good: '#d1fae5', warn: '#fef3c7', bad: '#fee2e2', info: '#e0f2fe' }[tone];
  const color = { neutral: C.ink7, good: '#065f46', warn: '#92400e', bad: '#991b1b', info: '#075985' }[tone];
  return <Text style={{ backgroundColor: bg, color, fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' }}>{text}</Text>;
}

export function tone(st?: string): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (!st) return 'neutral';
  if (['COMPLETED', 'COLLECTED', 'DELIVERED', 'CONFIRMED', 'SEATED', 'LIVE', 'PAID', 'CAPTURED', 'APPROVED'].includes(st)) return 'good';
  if (['SUBMITTED', 'HELD', 'REQUESTED', 'QUOTED', 'WAITING', 'NOTIFIED', 'OFFERED', 'PENDING'].includes(st)) return 'warn';
  if (['REJECTED', 'CANCELED', 'FAILED', 'NO_SHOW', 'EXPIRED', 'UNASSIGNED', 'SUSPENDED'].includes(st)) return 'bad';
  return 'info';
}

export function Loading() {
  return <View style={{ padding: 24, alignItems: 'center' }}><ActivityIndicator color={C.brand} /></View>;
}

export function ErrorText({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <Text style={{ color: C.bad, fontSize: 13, marginVertical: 6 }}>{msg}</Text>;
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 24, fontWeight: '700', color: C.ink, marginBottom: 8 }}>{children}</Text>;
}
export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: C.ink5, fontSize: 13 }}>{children}</Text>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16 },
  btn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginVertical: 4 },
  card: { backgroundColor: C.white, borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.ink1 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: C.ink },
  label: { fontSize: 12, color: C.ink5, marginBottom: 4, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: C.ink1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: C.white, fontSize: 14, color: C.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
