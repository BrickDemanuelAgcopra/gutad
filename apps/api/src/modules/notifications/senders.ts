import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../../config/config';
import type { Rendered } from './templates';

/**
 * Channel senders. "log" providers write to the application log so pilots run without external accounts.
 * Twilio (SMS) and SMTP (email) use plain fetch/SMTP-over-fetch-less approach: Twilio REST; SMTP via nodemailer
 * is intentionally avoided to keep dependencies small — use an HTTP email API by setting SMTP_URL to an https URL
 * that accepts {from,to,subject,text} JSON (e.g. a Postmark/Resend-compatible relay), or keep "log".
 */
@Injectable()
export class Senders {
  private readonly log = new Logger('Notify');

  async email(to: string, r: Rendered): Promise<void> {
    const cfg = loadConfig();
    if (cfg.EMAIL_PROVIDER === 'smtp' && cfg.SMTP_URL.startsWith('http')) {
      const res = await fetch(cfg.SMTP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.EMAIL_FROM, to, subject: r.subject, text: r.text }) });
      if (!res.ok) throw new Error(`email relay ${res.status}`);
      return;
    }
    this.log.log(`[email → ${to}] ${r.subject} :: ${r.text}`);
  }

  async sms(to: string, r: Rendered): Promise<void> {
    const cfg = loadConfig();
    if (cfg.SMS_PROVIDER === 'twilio' && cfg.TWILIO_ACCOUNT_SID) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: cfg.TWILIO_FROM, To: to, Body: r.sms }),
      });
      if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    this.log.log(`[sms → ${to}] ${r.sms}`);
  }

  async push(token: string, r: Rendered, data: Record<string, unknown>): Promise<void> {
    const cfg = loadConfig();
    if (token.startsWith('ExponentPushToken')) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${cfg.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify({ to: token, title: r.subject, body: r.sms, data }),
      });
      if (!res.ok) throw new Error(`expo push ${res.status}`);
      return;
    }
    this.log.log(`[push → ${token}] ${r.subject}`);
  }
}
