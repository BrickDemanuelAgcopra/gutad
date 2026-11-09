import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { C } from '@/ui';
import { BrandLogo } from '@/brand';

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: C.brand, headerStyle: { backgroundColor: C.bg }, headerShadowVisible: false }}>
      <Tabs.Screen name="index" options={{ title: 'Discover', headerTitle: () => <BrandLogo />, headerTitleAlign: 'left', tabBarIcon: ({ color, size }) => <Ionicons name="search" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: ({ color, size }) => <Ionicons name="bag-handle" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="reservations" options={{ title: 'Tables', tabBarIcon: ({ color, size }) => <Ionicons name="restaurant" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
