import { Text, View } from 'react-native';

/** Green "G" badge: menus prepared by Gutad's culinary team at a Gutad food hall (Made at Gutad). */
export function GBadge({ size = 18 }: { size?: number }) {
  return (
    <View accessibilityLabel="Made at Gutad" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#059669', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: size * 0.62, lineHeight: size * 0.8 }}>G</Text>
    </View>
  );
}

export function MadeAtGutad() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#ecfdf5', borderRadius: 999, paddingLeft: 2, paddingRight: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <GBadge size={16} />
      <Text style={{ color: '#065f46', fontSize: 11, fontWeight: '700' }}>Made at Gutad</Text>
    </View>
  );
}
