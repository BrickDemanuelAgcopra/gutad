import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../../config/config';
import type { Rendered } from './templates';

const TIMEOUT_MS = 15_000;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain-text body → minimal HTML: escaped, links clickable, line breaks kept. */
export function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">${body}</body></html>`;
}

/** Twilio wants E.164; tolerate spaces, dashes and brackets in stored numbers. */
export function toE164(phone: string): string {
  const p = phone.trim().replace(/[\s\-().]/g, '');
  return p.startsWith('00') ? `+${p.slice(2)}` : p;
}

/**
 * Channel senders. "log" providers write to the application log so pilots run without external accounts.
 * - Email: Brevo transactional API (EMAIL_PROVIDER=brevo), or an HTTP relay at SMTP_URL that accepts {from,to,subject,text}.
 * - SMS: Twilio REST (sender number or Messaging Service).
 * - Push: Expo.
 * A thrown error marks the notification FAILED; failed rows are retried for a day.
 */
@Injectable()
export class Senders {
  private readonly log = new Logger('Notify');

  async email(to: string, r: Rendered): Promise<{ provider: string; id?: string }> {
    const cfg = loadConfig();
    if (cfg.EMAIL_PROVIDER === 'brevo') {
      if (!cfg.BREVO_API_KEY) throw new Error('EMAIL_PROVIDER=brevo but BREVO_API_KEY is empty');
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': cfg.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: cfg.EMAIL_FROM, name: cfg.EMAIL_FROM_NAME },
          to: [{ email: to }],
          ...(cfg.EMAIL_REPLY_TO ? { replyTo: { email: cfg.EMAIL_REPLY_TO } } : {}),
          subject: r.subject,
          textContent: r.text,
          htmlContent: textToHtml(r.text),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { provider: 'brevo', id: j.messageId };
    }
    if (cfg.EMAIL_PROVIDER === 'smtp' && cfg.SMTP_URL.startsWith('http')) {
      const res = await fetch(cfg.SMTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.EMAIL_FROM, to, subject: r.subject, text: r.text }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`email relay ${res.status}`);
      return { provider: 'smtp' };
    }
    this.log.log(`[email → ${to}] ${r.subject} :: ${r.text}`);
    return { provider: 'log' };
  }

  async sms(to: string, r: Rendered): Promise<{ provider: string; id?: string }> {
    const cfg = loadConfig();
    if (cfg.SMS_PROVIDER === 'twilio') {
      if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) throw new Error('SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN is empty');
      if (!cfg.TWILIO_MESSAGING_SERVICE_SID && !cfg.TWILIO_FROM) throw new Error('Set TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
      const params = new URLSearchParams({ To: toE164(to), Body: r.sms });
      if (cfg.TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', cfg.TWILIO_MESSAGING_SERVICE_SID);
      else params.set('From', cfg.TWILIO_FROM);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json().catch(() => ({}))) as { sid?: string };
      return { provider: 'twilio', id: j.sid };
    }
    this.log.log(`[sms → ${to}] ${r.sms}`);
    return { provider: 'log' };
  }

  async push(token: string, r: Rendered, data: Record<string, unknown>): Promise<void> {
    const cfg = loadConfig();
    if (token.startsWith('ExponentPushToken')) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${cfg.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify({ to: token, title: r.subject, body: r.sms, data }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`expo push ${res.status}`);
      return;
    }
    this.log.log(`[push → ${token}] ${r.subject}`);
  }
}
