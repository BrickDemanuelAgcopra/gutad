import { useState } from 'react';
import { Text, View } from 'react-native';
import { api, money, when } from './api';
import { useAction, useApi } from './hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted } from './ui';

interface Ticket { id: string; category: string; status: string; remedy: string | null; remedyCents: number; resolvedAt: string | null; createdAt: string; orderNumber: string | null; organizationId: string | null; role: 'MERCHANT' | 'DRIVER'; dispute: { status: string | null; reason: string | null; note: string | null } | null; canDispute: boolean }

const LABEL: Record<string, string> = { OPEN: 'Under review', UPHELD: 'Upheld', REVERSED: 'Reversed' };

/**
 * 24.6-W resolved tickets where the merchant (owner/manager) or the courier was held responsible, with a way to ask
 * Gutad to review the decision. The API only returns tickets charged to the caller's party.
 */
export function ResponsibilityDisputes({ role, organizationId }: { role: 'MERCHANT' | 'DRIVER'; organizationId?: string | null }) {
  const { data, reload } = useApi<Ticket[]>('/me/responsibility-tickets', { deps: [organizationId] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const rows = (data || []).filter((t) => t.role === role && (role === 'DRIVER' || t.organizationId === organizationId));
  if (!data || (!rows.length && role === 'DRIVER')) return null;
  return (
    <Card title={role === 'DRIVER' ? 'Tickets charged to you' : 'Responsibility decisions'}>
      <Muted>{role === 'DRIVER' ? 'Resolved complaints where you were held responsible. If you disagree, tell Gutad why and support reviews it.' : 'Resolved tickets charged to your business. A reversal re-credits any refund you funded.'}</Muted>
      {sent && <Text style={{ color: C.good, marginVertical: 4 }}>Sent. Gutad support will review the decision.</Text>}
      <ErrorText msg={error} />
      {rows.map((t) => (
        <View key={t.id} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontWeight: '600', color: C.ink, flexShrink: 1 }}>{t.category.toLowerCase().replace(/_/g, ' ')}{t.orderNumber ? ` · ${t.orderNumber}` : ''}</Text>
            <Badge text={t.dispute?.status ? LABEL[t.dispute.status] || t.dispute.status : t.status} tone={t.dispute?.status === 'REVERSED' ? 'good' : t.dispute?.status === 'OPEN' ? 'info' : 'neutral'} />
          </View>
          <Muted>{when(t.resolvedAt || t.createdAt)}{t.remedy ? ` · ${t.remedy.toLowerCase()}${t.remedyCents ? ` ${money(t.remedyCents)}` : ''}` : ''}</Muted>
          {t.dispute?.reason && <Muted>Your reason: {t.dispute.reason}{t.dispute.note ? ` · Gutad: ${t.dispute.note}` : ''}</Muted>}
          {t.canDispute && open !== t.id && <Button title="Dispute responsibility" variant="secondary" onPress={() => { setOpen(t.id); setReason(''); setSent(false); }} />}
          {open === t.id && (
            <View>
              <Input label="Why shouldn’t this be on you?" multiline value={reason} onChangeText={setReason} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Button title="Send dispute" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/incidents/${t.id}/dispute-responsibility`, { reason: reason.trim() }); setOpen(null); setSent(true); reload(); })} />
                <Button title="Cancel" variant="ghost" onPress={() => setOpen(null)} />
              </View>
            </View>
          )}
        </View>
      ))}
      {!rows.length && <Muted>No tickets were charged to your business.</Muted>}
    </Card>
  );
}
