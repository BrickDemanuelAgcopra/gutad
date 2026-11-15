import Link from 'next/link';
import { LegalPage, SUPPORT_EMAIL } from '@/components/legal';

export const metadata = { title: 'Terms of Service', description: 'The terms for using Gutad to order food, book tables and events, including our SMS terms.' };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These terms apply when you use gutad.io, the Gutad mobile apps and related services (the &quot;Services&quot;) provided by Gutad LLC (&quot;Gutad&quot;, &quot;we&quot;, &quot;us&quot;). By using the Services you agree to them. Restaurants selling on Gutad are also bound by the <Link className="underline" href="/merchant-agreement">Merchant Agreement</Link>.
        </p>
      }
      sections={[
        {
          id: 'service', title: 'What Gutad does',
          body: <p>Gutad lets you order food for pickup, delivery or dine-in, book tables, tickets and private events, and buy gift cards and memberships. Some kitchens are operated by Gutad (&quot;Made at Gutad&quot;); others are independent restaurants that prepare and are responsible for their own food. Each restaurant&apos;s page shows who prepares your order.</p>,
        },
        {
          id: 'account', title: 'Your account',
          body: <p>You must be at least 13 to use the Services and old enough to form a binding contract where you live to place orders. Keep your sign-in details secure and tell us if you think someone else has used your account. You are responsible for activity on your account and for giving accurate contact and delivery details.</p>,
        },
        {
          id: 'orders', title: 'Orders, prices and payment',
          body: (
            <ul>
              <li>Prices, fees, taxes and estimated times are shown before you pay. Estimated times are not guaranteed.</li>
              <li>Placing an order authorizes us to charge your payment method. We may place a temporary hold that is released if the order is not accepted.</li>
              <li>A restaurant may decline an order or mark items unavailable; you will be offered a replacement, a credit or a refund for those items.</li>
              <li>Allergen and dietary information comes from the restaurant. If you have a serious allergy, contact the restaurant before ordering.</li>
              <li>Alcohol, where offered, is sold only to adults of legal drinking age, and ID may be checked on pickup or delivery.</li>
            </ul>
          ),
        },
        {
          id: 'cancellations', title: 'Cancellations, refunds and reservations',
          body: <p>While cancellation is still available, you can cancel an order from its order page. After that, refunds depend on the problem and are handled through your order page or support. Reservations and tickets follow the cancellation and no-show policy shown when you book, which may include a fee. Unused pickup orders are held for the time shown on the order and then handled as described there.</p>,
        },
        {
          id: 'sms', title: 'SMS terms',
          body: (
            <>
              <p><b>Program:</b> Gutad order, delivery, reservation and account notifications.</p>
              <p><b>Consent:</b> by providing your mobile number at checkout, when booking, or in your account, you agree to receive transactional text messages from Gutad about your orders, deliveries, reservations, waitlist status, tickets and account security. Marketing texts are sent only if you separately opt in. Consent is not a condition of purchase.</p>
              <p><b>Frequency:</b> message frequency varies with your activity, typically a few messages per order or reservation.</p>
              <p><b>Cost:</b> message and data rates may apply. Gutad does not charge for text messages.</p>
              <p><b>Opt out:</b> reply <b>STOP</b> to any message to stop receiving texts. You will get one confirmation message and no more texts unless you reply <b>START</b>. You can also turn texts off under Account → Notifications.</p>
              <p><b>Help:</b> reply <b>HELP</b> for help, or email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
              <p><b>Carriers:</b> carriers are not liable for delayed or undelivered messages.</p>
              <p><b>Privacy:</b> see our <Link className="underline" href="/privacy#sms">Privacy Policy</Link>. We do not share your mobile number with third parties for their marketing.</p>
            </>
          ),
        },
        {
          id: 'rewards', title: 'Gift cards, credits, rewards and memberships',
          body: <p>Gift cards and credits have no cash value except where the law requires, cannot be resold, and may carry the expiry shown when issued. Reward points, challenges and referral rewards follow the rules shown in the app and may be changed or ended with notice. Memberships renew automatically until canceled; you can cancel any time under Account → Rewards, and benefits continue until the end of the paid period.</p>,
        },
        {
          id: 'conduct', title: 'Acceptable use',
          body: (
            <ul>
              <li>Do not misuse the Services: no fraud, chargeback abuse, fake orders or reviews, scraping, or attempts to break security.</li>
              <li>Treat restaurant staff, couriers and support with respect.</li>
              <li>We may limit, suspend or close accounts that break these terms. You can appeal from your account.</li>
            </ul>
          ),
        },
        {
          id: 'content', title: 'Reviews and content',
          body: <p>You keep ownership of reviews, photos and messages you post, and give Gutad a license to display them in connection with the Services. Do not post anything unlawful, misleading or that you do not have the right to share.</p>,
        },
        {
          id: 'disclaimers', title: 'Disclaimers and liability',
          body: <p>The Services are provided &quot;as is&quot;. To the extent the law allows, Gutad is not liable for indirect or consequential losses, and our total liability for any claim relating to an order is limited to the amount you paid for that order. Nothing in these terms limits rights you have under consumer protection law that cannot be waived.</p>,
        },
        {
          id: 'changes', title: 'Changes and contact',
          body: <p>We may update these terms and will post the new version here with a new effective date. Continuing to use the Services after an update means you accept it. Questions: <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>,
        },
      ]}
    />
  );
}
