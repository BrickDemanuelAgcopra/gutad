import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, ScrollView, Text, Vibration, View } from 'react-native';
import { Button, C } from '@/ui';
import type { Offer } from './common';
import { OfferCard } from './work';

const PATTERN = [0, 700, 400, 700, 400, 700, 1200];

/**
 * Full-screen offer alarm on the Driver screen: a pulsing sheet with the offer (Accept/Decline and its countdown) and a
 * repeating vibration until the courier answers, hides it, or it expires. The push notification on the "offers"
 * channel carries the sound, including when the app is closed.
 */
export function OfferAlarm({ offers, onDone }: { offers: Offer[]; onDone: () => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  const live = offers.filter((o) => new Date(o.expiresAt).getTime() > Date.now() && !hidden.has(o.id));
  const open = live.length > 0;
  const pulse = useRef(new Animated.Value(0)).current;

  // re-check expiry every second so the sheet closes when the last offer runs out
  useEffect(() => {
    if (!offers.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [offers.length]);

  useEffect(() => {
    if (!open) { Vibration.cancel(); return; }
    Vibration.vibrate(PATTERN, true);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: false }),
    ]));
    loop.start();
    return () => { Vibration.cancel(); loop.stop(); };
  }, [open, pulse]);

  if (!open) return null;
  const bg = pulse.interpolate({ inputRange: [0, 1], outputRange: ['rgba(244,93,10,0.55)', 'rgba(244,93,10,0.9)'] });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setHidden(new Set([...hidden, ...live.map((o) => o.id)]))}>
      <Animated.View style={{ flex: 1, backgroundColor: bg, justifyContent: 'center', padding: 16 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden', maxHeight: '90%' }}>
          <View style={{ backgroundColor: C.brand, paddingVertical: 14, paddingHorizontal: 16 }}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{live.length === 1 ? 'New delivery offer!' : `${live.length} delivery offers!`}</Text>
            <Text style={{ color: '#fff' }}>Accept before the timer runs out.</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {live.map((o) => <OfferCard key={o.id} o={o} onDone={onDone} />)}
            <Button title="Hide (offer stays in your list)" variant="ghost" onPress={() => setHidden(new Set([...hidden, ...live.map((o) => o.id)]))} />
          </ScrollView>
        </View>
      </Animated.View>
    </Modal>
  );
}
