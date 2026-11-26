import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { loadConfig } from '../../config/config';
import { blocksFromText, renderEmailHtml } from './email-layout';
import type { Rendered } from './templates';

const TIMEOUT_MS = 15_000;

/** Full branded HTML for an email: the template's designed blocks, or its text in the same layout. */
export function emailHtml(r: Rendered): string {
  const cfg = loadConfig();
  return renderEmailHtml(r.email || blocksFromText(r.subject, r.text), { webUrl: cfg.PUBLIC_WEB_URL, supportEmail: cfg.EMAIL_REPLY_TO || 'support@gutad.io', subject: r.subject });
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

/** Expo push delivery hints: Android channel, sound file bundled in the app, delivery priority. */
export interface PushOptions { channelId?: string; sound?: string; priority?: 'default' | 'normal' | 'high' }

@Injectable()
export class Senders {
  private readonly log = new Logger('Notify');
  private smtp?: { key: string; t: Transporter };

  private brevoSmtp(cfg: ReturnType<typeof loadConfig>): Transporter {
    const key = `${cfg.BREVO_SMTP_HOST}:${cfg.BREVO_SMTP_PORT}:${cfg.BREVO_SMTP_LOGIN}:${cfg.BREVO_API_KEY}`;
    if (this.smtp?.key !== key) {
      this.smtp = {
        key,
        t: createTransport({
          host: cfg.BREVO_SMTP_HOST, port: cfg.BREVO_SMTP_PORT, secure: cfg.BREVO_SMTP_PORT === 465, requireTLS: cfg.BREVO_SMTP_PORT !== 465,
          auth: { user: cfg.BREVO_SMTP_LOGIN, pass: cfg.BREVO_API_KEY },
          pool: true, maxConnections: 3, connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
        }),
      };
    }
    return this.smtp.t;
  }

  async email(to: string, r: Rendered): Promise<{ provider: string; id?: string }> {
    const cfg = loadConfig();
    if (cfg.EMAIL_PROVIDER === 'brevo') {
      if (!cfg.BREVO_API_KEY) throw new Error('EMAIL_PROVIDER=brevo but BREVO_API_KEY is empty');
      // An SMTP key (xsmtpsib-…) only works on Brevo's SMTP relay; an API key (xkeysib-…) uses the HTTP API.
      if (cfg.BREVO_API_KEY.startsWith('xsmtpsib-')) {
        if (!cfg.BREVO_SMTP_LOGIN) throw new Error('BREVO_API_KEY is a Brevo SMTP key: set BREVO_SMTP_LOGIN (Brevo > SMTP & API > SMTP, e.g. 9a1b2c001@smtp-brevo.com)');
        const info = await this.brevoSmtp(cfg).sendMail({
          from: { name: cfg.EMAIL_FROM_NAME, address: cfg.EMAIL_FROM },
          to,
          ...(cfg.EMAIL_REPLY_TO ? { replyTo: cfg.EMAIL_REPLY_TO } : {}),
          subject: r.subject,
          text: r.text,
          html: emailHtml(r),
        });
        return { provider: 'brevo-smtp', id: info.messageId };
      }
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': cfg.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: cfg.EMAIL_FROM, name: cfg.EMAIL_FROM_NAME },
          to: [{ email: to }],
          ...(cfg.EMAIL_REPLY_TO ? { replyTo: { email: cfg.EMAIL_REPLY_TO } } : {}),
          subject: r.subject,
          textContent: r.text,
          htmlContent: emailHtml(r),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { provider: 'brevo', id: j.messageId };
    }
    if (cfg.EMAIL_PROVIDER === 'smtp' && cfg.SMTP_URL.startsWith('http')) {
      const res = await fetch(cfg.SMTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.EMAIL_FROM, to, subject: r.subject, text: r.text, html: emailHtml(r) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
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
      // Carriers require the sender to be identified in every message (A2P 10DLC).
      const body = /^gutad\b/i.test(r.sms) ? r.sms : `Gutad: ${r.sms}`;
      const params = new URLSearchParams({ To: toE164(to), Body: body });
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

  async push(token: string, r: Rendered, data: Record<string, unknown>, opts?: PushOptions): Promise<void> {
    const cfg = loadConfig();
    if (token.startsWith('ExponentPushToken')) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${cfg.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify({ to: token, title: r.subject, body: r.sms, data, ...(opts?.sound ? { sound: opts.sound } : {}), ...(opts?.channelId ? { channelId: opts.channelId } : {}), ...(opts?.priority ? { priority: opts.priority } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`expo push ${res.status}`);
      return;
    }
    this.log.log(`[push → ${token}] ${r.subject}`);
  }
}
