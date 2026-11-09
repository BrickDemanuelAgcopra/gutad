import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { C } from '@/ui';
import { BrandLogo } from '@/brand';
import { FloatingTabBar } from '@/floating-tab-bar';

type IconName = keyof typeof Ionicons.glyphMap;
const icon = (on: IconName, off: IconName) => ({ focused, color, size }: { focused: boolean; color: unknown; size: number }) => <Ionicons name={focused ? on : off} color={String(color)} size={size} />;

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <FloatingTabBar {...props} />} screenOptions={{ headerStyle: { backgroundColor: C.bg }, headerShadowVisible: false, sceneStyle: { backgroundColor: C.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Discover', headerTitle: () => <BrandLogo />, headerTitleAlign: 'left', tabBarIcon: icon('compass', 'compass-outline') }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('bag-handle', 'bag-handle-outline') }} />
      <Tabs.Screen name="reservations" options={{ title: 'Tables', tabBarIcon: icon('restaurant', 'restaurant-outline') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
