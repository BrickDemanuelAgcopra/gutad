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
        <Stack.Screen name="ops/index" options={{ title: 'Gutad Ops' }} />
        <Stack.Screen name="ops/executive" options={{ title: 'Executive dashboard' }} />
        <Stack.Screen name="ops/live" options={{ title: 'Live operations' }} />
        <Stack.Screen name="ops/alerts" options={{ title: 'Alerts' }} />
        <Stack.Screen name="ops/orders" options={{ title: 'Orders' }} />
        <Stack.Screen name="ops/order/[id]" options={{ title: 'Order' }} />
        <Stack.Screen name="ops/locations" options={{ title: 'Locations' }} />
        <Stack.Screen name="ops/merchants" options={{ title: 'Merchants' }} />
        <Stack.Screen name="ops/brands" options={{ title: 'Brands & partners' }} />
        <Stack.Screen name="merchant/support" options={{ title: 'Support' }} />
        <Stack.Screen name="merchant/location" options={{ title: 'Location & launch' }} />
        <Stack.Screen name="ops/culinary" options={{ title: 'Menus & recipes review' }} />
        <Stack.Screen name="ops/pricing" options={{ title: 'Pricing, fees & tax' }} />
        <Stack.Screen name="merchant/recipes" options={{ title: 'Recipes' }} />
        <Stack.Screen name="ops/approvals" options={{ title: 'Approvals' }} />
        <Stack.Screen name="ops/security" options={{ title: 'Staff & access' }} />
        <Stack.Screen name="ops/audit" options={{ title: 'Audit history' }} />
        <Stack.Screen name="ops/structure" options={{ title: 'Organization structure' }} />
        <Stack.Screen name="ops/customers" options={{ title: 'Customers' }} />
        <Stack.Screen name="ops/kitchens" options={{ title: 'Kitchen operations' }} />
        <Stack.Screen name="ops/delivery" options={{ title: 'Delivery & dispatch' }} />
        <Stack.Screen name="ops/couriers" options={{ title: 'Couriers' }} />
        <Stack.Screen name="ops/finance" options={{ title: 'Finance' }} />
        <Stack.Screen name="ops/supply" options={{ title: 'Supply & inventory' }} />
        <Stack.Screen name="ops/growth" options={{ title: 'Growth' }} />
        <Stack.Screen name="rewards" options={{ title: 'Rewards & gift cards' }} />
        <Stack.Screen name="ops/safety" options={{ title: 'Food safety' }} />
        <Stack.Screen name="ops/workforce" options={{ title: 'Workforce & equipment' }} />
        <Stack.Screen name="merchant/ops" options={{ title: 'Shift tools' }} />
        <Stack.Screen name="merchant/finance" options={{ title: 'Finance' }} />
        <Stack.Screen name="ops/support" options={{ title: 'Support queue' }} />
        <Stack.Screen name="me" options={{ title: 'My account' }} />
        <Stack.Screen name="security" options={{ title: 'Security' }} />
        <Stack.Screen name="login" options={{ title: 'Sign in', presentation: 'modal' }} />
      </Stack>
    </>
  );
}
