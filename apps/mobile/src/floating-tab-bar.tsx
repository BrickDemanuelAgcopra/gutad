import { useEffect, useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { C } from '@/ui';

const BAR_HEIGHT = 64;
const PAD = 6;

/** Floating pill tab bar with a spring-animated highlight that slides to the active tab. */
export function FloatingTabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const [width, setWidth] = useState(0);
  const tabWidth = width > 0 ? (width - PAD * 2) / state.routes.length : 0;
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!tabWidth) return;
    Animated.spring(x, { toValue: state.index * tabWidth, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }).start();
  }, [state.index, tabWidth, x]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w !== width) { setWidth(w); x.setValue(state.index * ((w - PAD * 2) / state.routes.length)); }
  };

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
      <View style={styles.bar} onLayout={onLayout} role="tablist">
        {tabWidth > 0 && <Animated.View style={[styles.highlight, { width: tabWidth, transform: [{ translateX: x }] }]} />}
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const focused = index === state.index;
          const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : options.title ?? route.name;
          const color = focused ? C.brand : C.ink5;
          const onPress = () => {
            const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigateToTab(route.key);
          };
          const onLongPress = () => emitter.emit({ type: 'tabLongPress', target: route.key });
          return <TabButton key={route.key} label={label} focused={focused} onPress={onPress} onLongPress={onLongPress} icon={options.tabBarIcon?.({ focused, color, size: 22 })} color={color} />;
        })}
      </View>
    </View>
  );
}

function TabButton({ label, focused, onPress, onLongPress, icon, color }: { label: string; focused: boolean; onPress: () => void; onLongPress: () => void; icon: React.ReactNode; color: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 8 }).start();
  return (
    <Pressable
      role="tab"
      aria-selected={focused}
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
      style={styles.tab}
      hitSlop={4}
    >
      <Animated.View style={[styles.tabInner, { transform: [{ scale }] }]}>
        {icon}
        <Text numberOfLines={1} style={[styles.label, { color, fontWeight: focused ? '700' : '500' }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: C.bg, paddingHorizontal: 16, paddingTop: 6 },
  bar: {
    flexDirection: 'row',
    height: BAR_HEIGHT,
    padding: PAD,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: C.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ink1,
    ...Platform.select({
      ios: { shadowColor: C.ink, shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 10 },
      default: { boxShadow: '0 8px 24px rgba(20,18,16,.14)' },
    }),
  },
  highlight: { position: 'absolute', top: PAD, bottom: PAD, left: PAD, borderRadius: (BAR_HEIGHT - PAD * 2) / 2, backgroundColor: '#fff1e6' },
  tab: { flex: 1 },
  tabInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 11, letterSpacing: 0.1 },
});
