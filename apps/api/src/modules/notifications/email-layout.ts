/**
 * Branded HTML layout shared by every transactional email.
 *
 * Built for email clients, not browsers: table layout, inline styles, a bulletproof button, a hidden preheader,
 * PNG logo (Gmail/Outlook do not render SVG), max width 600px with a mobile breakpoint. Colors follow the web
 * Tailwind palette (brand-500 #f45d0a, ink scale). Every dynamic string is escaped here, so templates pass plain text.
 */

export type EmailTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
export type EmailAudience = 'customer' | 'merchant' | 'staff' | 'courier';

export interface EmailBlocks {
  /** Inbox preview line (hidden in the body). Defaults to the first paragraph. */
  preheader?: string;
  /** Small pill above the heading, e.g. "Order confirmed". */
  eyebrow?: string;
  tone?: EmailTone;
  heading: string;
  paragraphs?: string[];
  /** Highlighted code (pickup code, confirmation code, gift card). */
  code?: { label: string; value: string };
  /** Label/value rows. Empty values are dropped. */
  details?: Array<[string, string | number | null | undefined]>;
  cta?: { label: string; url: string };
  /** Small print under the button (expiry, safety advice). */
  note?: string;
  audience?: EmailAudience;
}

export interface EmailLayoutOptions {
  webUrl: string;
  supportEmail: string;
  /** Raw-string fallback when a template has no blocks. */
  subject: string;
}

const C = {
  brand: '#f45d0a',
  brandDark: '#d94a05',
  brand50: '#fff4ec',
  brand200: '#ffc9a3',
  ink900: '#141210',
  ink700: '#3a3632',
  ink500: '#6b655f',
  ink300: '#b5aea6',
  ink100: '#efeae4',
  ink50: '#faf7f3',
};

const TONES: Record<EmailTone, { fg: string; bg: string }> = {
  brand: { fg: '#b03a08', bg: '#fff4ec' },
  success: { fg: '#166534', bg: '#ecfdf3' },
  warning: { fg: '#92400e', bg: '#fffbeb' },
  danger: { fg: '#b42318', bg: '#fef3f2' },
  neutral: { fg: '#3a3632', bg: '#f4f1ec' },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Escape, then make bare URLs clickable and keep single line breaks. */
const rich = (s: string) =>
  esc(s)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, `<a href="$1" style="color:${C.brandDark};text-decoration:underline">$1</a>`)
    .replace(/\n/g, '<br>');

const safeUrl = (u: string) => (/^(https?:|mailto:)/i.test(u) ? u : '#');

const FOOTER_WHY: Record<EmailAudience, string> = {
  customer: 'You received this email because of activity on your Gutad account or order.',
  merchant: 'You received this email because you manage a business on Gutad.',
  staff: 'You received this email because you are a member of the Gutad team.',
  courier: 'You received this email because you deliver with Gutad.',
};

const ACCOUNT_LINK: Record<EmailAudience, [string, string]> = {
  customer: ['Your account', '/account'],
  merchant: ['Merchant dashboard', '/merchant'],
  staff: ['Control center', '/admin'],
  courier: ['Courier app', '/driver'],
};

/** Blocks derived from plain text, for templates without a designed body. */
export function blocksFromText(subject: string, text: string): EmailBlocks {
  return { heading: subject, paragraphs: text.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean) };
}

export function renderEmailHtml(b: EmailBlocks, o: EmailLayoutOptions): string {
  const web = o.webUrl.replace(/\/$/, '');
  const audience = b.audience || 'customer';
  const tone = TONES[b.tone || 'brand'];
  const preheader = b.preheader || b.paragraphs?.[0] || b.heading;
  const details = (b.details || []).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
  const [accountLabel, accountPath] = ACCOUNT_LINK[audience];

  const eyebrow = b.eyebrow
    ? `<tr><td style="padding:0 0 12px"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${tone.bg};color:${tone.fg};font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase">${esc(b.eyebrow)}</span></td></tr>`
    : '';

  const paragraphs = (b.paragraphs || [])
    .map((p) => `<tr><td style="padding:0 0 14px;font-size:16px;line-height:1.6;color:${C.ink700}">${rich(p)}</td></tr>`)
    .join('');

  const code = b.code
    ? `<tr><td style="padding:6px 0 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ${C.brand200};border-radius:12px;background:${C.brand50}">
          <tr><td align="center" style="padding:16px 12px">
            <div style="font-size:12px;color:${C.ink500};text-transform:uppercase;letter-spacing:.08em;font-weight:600">${esc(b.code.label)}</div>
            <div style="padding-top:6px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:28px;line-height:1.2;font-weight:700;letter-spacing:.12em;color:${C.ink900}">${esc(b.code.value)}</div>
          </td></tr>
        </table>
      </td></tr>`
    : '';

  const detailRows = details
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:10px 0;${i ? `border-top:1px solid ${C.ink100};` : ''}font-size:14px;color:${C.ink500};vertical-align:top" width="42%">${esc(k)}</td><td style="padding:10px 0;${i ? `border-top:1px solid ${C.ink100};` : ''}font-size:14px;color:${C.ink900};font-weight:600;text-align:right;vertical-align:top">${rich(String(v))}</td></tr>`,
    )
    .join('');
  const detailTable = detailRows
    ? `<tr><td style="padding:4px 0 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ink50};border-radius:12px"><tr><td style="padding:6px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table></td></tr></table></td></tr>`
    : '';

  const cta = b.cta
    ? `<tr><td style="padding:6px 0 8px">
        <table role="presentation" cellpadding="0" cellspacing="0" class="btn"><tr>
          <td align="center" bgcolor="${C.brand}" style="border-radius:10px;background:${C.brand}">
            <a href="${esc(safeUrl(b.cta.url))}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${esc(b.cta.label)}</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:4px 0 14px;font-size:12px;line-height:1.5;color:${C.ink500}">Button not working? Paste this link into your browser:<br><a href="${esc(safeUrl(b.cta.url))}" style="color:${C.ink500};word-break:break-all">${esc(b.cta.url)}</a></td></tr>`
    : '';

  const note = b.note ? `<tr><td style="padding:8px 0 0;font-size:13px;line-height:1.5;color:${C.ink500}">${rich(b.note)}</td></tr>` : '';

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.subject)}</title>
<style>
  body{margin:0;padding:0;background:${C.ink50}}
  a{color:${C.brandDark}}
  @media (max-width:620px){
    .container{width:100%!important}
    .card{border-radius:0!important;border-left:0!important;border-right:0!important}
    .pad{padding-left:20px!important;padding-right:20px!important}
    .btn,.btn td,.btn a{width:100%!important;display:block!important;box-sizing:border-box}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.ink50};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(preheader)}${'&#8204;&nbsp;'.repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ink50}">
  <tr><td align="center" style="padding:28px 12px">
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px">
      <tr><td class="pad" style="padding:0 8px 18px">
        <a href="${esc(web)}" style="text-decoration:none">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle"><img src="${esc(web)}/icon-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px"></td>
            <td style="vertical-align:middle;padding-left:10px;font-size:20px;font-weight:800;letter-spacing:-.02em;color:${C.ink900}">Gutad</td>
          </tr></table>
        </a>
      </td></tr>
      <tr><td>
        <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${C.ink100};border-radius:16px;overflow:hidden">
          <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.brand}">&nbsp;</td></tr>
          <tr><td class="pad" style="padding:32px 36px 28px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${eyebrow}
              <tr><td style="padding:0 0 14px;font-size:24px;line-height:1.3;font-weight:700;letter-spacing:-.01em;color:${C.ink900}">${esc(b.heading)}</td></tr>
              ${paragraphs}${code}${detailTable}${cta}${note}
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="pad" style="padding:22px 16px 8px;font-size:12px;line-height:1.6;color:${C.ink500};text-align:center">
        Questions? Reply to this email or write to <a href="mailto:${esc(o.supportEmail)}" style="color:${C.ink500}">${esc(o.supportEmail)}</a>.<br>
        <a href="${esc(web)}${accountPath}" style="color:${C.ink500}">${accountLabel}</a> &nbsp;·&nbsp; <a href="${esc(web)}" style="color:${C.ink500}">gutad.io</a>
      </td></tr>
      <tr><td class="pad" style="padding:4px 16px 0;font-size:11px;line-height:1.6;color:${C.ink300};text-align:center">${FOOTER_WHY[audience]}<br>© ${new Date().getFullYear()} Gutad</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
