import Link from 'next/link';

export const LEGAL_EFFECTIVE = 'November 14, 2026';
export const SUPPORT_EMAIL = 'support@gutad.io';

/** Shared shell for the public legal pages (/privacy, /terms). */
export function LegalPage({ title, intro, sections }: { title: string; intro: React.ReactNode; sections: { id: string; title: string; body: React.ReactNode }[] }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-ink-500">Effective {LEGAL_EFFECTIVE}</p>
      <div className="mt-4 text-ink-700">{intro}</div>
      <nav aria-label="Contents" className="mt-6 rounded-2xl border border-ink-100 bg-white p-4 text-sm shadow-card">
        <b className="text-ink-900">Contents</b>
        <ol className="mt-2 grid list-decimal gap-1 pl-5 sm:grid-cols-2">
          {sections.map((s) => <li key={s.id}><a className="underline" href={`#${s.id}`}>{s.title}</a></li>)}
        </ol>
      </nav>
      <div className="mt-6 space-y-8 rounded-2xl border border-ink-100 bg-white p-6 shadow-card">
        {sections.map((s, i) => (
          <section key={s.id} id={s.id} className="scroll-mt-20">
            <h2 className="text-lg font-semibold text-ink-900">{i + 1}. {s.title}</h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-700 [&_li]:ml-5 [&_li]:list-disc">{s.body}</div>
          </section>
        ))}
      </div>
      <p className="mt-6 text-sm text-ink-500">Questions? Email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. See also our <Link className="underline" href="/privacy">Privacy Policy</Link> and <Link className="underline" href="/terms">Terms of Service</Link>.</p>
    </div>
  );
}

/**
 * Disclosure shown next to every customer phone field. Carriers (A2P 10DLC review) look for this exact set of facts:
 * who sends, what kind of texts, frequency, rates, STOP/HELP, and links to terms and privacy.
 */
export function SmsNotice({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-ink-500 ${className}`}>
      By giving your mobile number you agree to receive texts from Gutad about your orders, deliveries and reservations, and account security alerts. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our <Link className="underline" href="/terms#sms">SMS terms</Link> and <Link className="underline" href="/privacy">Privacy Policy</Link>.
    </p>
  );
}
