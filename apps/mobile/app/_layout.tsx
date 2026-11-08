import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { usePush } from '@/push';
import { C } from '@/ui';

export default function RootLayout() {
  usePush();
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: C.ink, headerStyle: { backgroundColor: C.bg }, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="r/[slug]" options={{ title: 'Restaurant' }} />
        <Stack.Screen name="checkout" options={{ title: 'Checkout' }} />
        <Stack.Screen name="order/[id]" options={{ title: 'Order' }} />
        <Stack.Screen name="reserve/[slug]" options={{ title: 'Reserve a table' }} />
        <Stack.Screen name="merchant/index" options={{ title: 'Merchant tablet' }} />
        <Stack.Screen name="merchant/host" options={{ title: 'Host stand' }} />
        <Stack.Screen name="merchant/kitchen" options={{ title: 'Kitchen' }} />
        <Stack.Screen name="driver/index" options={{ title: 'Driver' }} />
        <Stack.Screen name="login" options={{ title: 'Sign in', presentation: 'modal' }} />
      </Stack>
    </>
  );
}
