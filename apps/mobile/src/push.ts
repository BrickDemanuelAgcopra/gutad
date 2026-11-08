import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useRouter, type Href } from 'expo-router';
import { api } from './api';
import { useSession } from './hooks';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Expo project id written to app.json by `eas init`; push tokens cannot be issued without it. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

async function register(): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return; // simulators/emulators cannot receive push
  const id = projectId();
  if (!id) {
    console.warn('[push] no EAS projectId in app.json (run `eas init`); push disabled');
    return;
  }
  // Android 13+ only shows the permission prompt once a channel exists.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Orders & reservations', importance: Notifications.AndroidImportance.HIGH, lightColor: '#f45d0a', vibrationPattern: [0, 250, 250, 250] });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  await api.post('/auth/me/push-token', { token });
}

/** Where a tapped notification should take the user; data comes from the server's event payload. */
export function routeFor(data: Record<string, unknown> | undefined): Href | null {
  if (!data) return null;
  const topic = typeof data.topic === 'string' ? data.topic : '';
  const orderId = typeof data.orderId === 'string' ? data.orderId : topic.startsWith('order.') && typeof data.aggregateId === 'string' ? data.aggregateId : null;
  if (topic === 'order.submitted') return '/merchant';
  if (orderId) return { pathname: '/order/[id]', params: { id: orderId } };
  if (/^(reservation|waitlist|ticket)\./.test(topic)) return '/reservations';
  return null;
}

/** Registers this device for push while signed in, and opens the right screen when a notification is tapped. */
export function usePush() {
  const { user } = useSession();
  const router = useRouter();
  const lastResponse = Notifications.useLastNotificationResponse(); // includes the tap that launched the app

  useEffect(() => {
    if (!user) return;
    register().catch((e) => console.warn('[push] registration failed', e));
    // Tokens can rotate (reinstall, OS restore); keep the server's copy current.
    const sub = Notifications.addPushTokenListener(() => { register().catch(() => undefined); });
    return () => sub.remove();
  }, [user?.id]);

  useEffect(() => {
    if (!lastResponse || lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const href = routeFor(lastResponse.notification.request.content.data as Record<string, unknown>);
    if (href) router.push(href);
    // Mark handled so the same tap is not replayed when this screen re-renders.
    void Notifications.clearLastNotificationResponseAsync?.();
  }, [lastResponse]);
}
