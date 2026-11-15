import { Linking, Text } from 'react-native';
import { C } from './ui';

const WEB = process.env.EXPO_PUBLIC_WEB_URL || 'https://gutad.io';

/** SMS disclosure shown under every customer phone field (A2P 10DLC consent language; mirrors the web SmsNotice). */
export function SmsNotice() {
  const link = (label: string, path: string) => <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(`${WEB}${path}`)}>{label}</Text>;
  return (
    <Text style={{ fontSize: 11, lineHeight: 16, color: C.ink5, marginBottom: 8 }}>
      By giving your mobile number you agree to receive texts from Gutad about your orders, deliveries and reservations, and account security alerts. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our {link('SMS terms', '/terms#sms')} and {link('Privacy Policy', '/privacy')}.
    </Text>
  );
}
