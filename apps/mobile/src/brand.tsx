import { Image, Text, View } from 'react-native';
import { C } from '@/ui';

const mark = require('../assets/logo.png');

/** Gutad logo lockup: chopped-G mark + wordmark. */
export function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.3 }}>
      <Image source={mark} style={{ width: size, height: size, borderRadius: size * 0.23 }} accessibilityLabel="Gutad" />
      <Text style={{ fontSize: size * 0.72, fontWeight: '800', letterSpacing: -0.5, color: C.ink }}>gutad</Text>
    </View>
  );
}
