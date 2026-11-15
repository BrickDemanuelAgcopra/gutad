import Link from 'next/link';
import { LegalPage, SUPPORT_EMAIL } from '@/components/legal';

export const metadata = { title: 'Privacy Policy', description: 'How Gutad collects, uses, shares and protects personal information, including mobile numbers and text messages.' };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={<p>This policy explains how Gutad LLC (&quot;Gutad&quot;, &quot;we&quot;, &quot;us&quot;) handles personal information when you use gutad.io, the Gutad mobile apps and related services to order food, book tables and events, or run a restaurant on our platform.</p>}
      sections={[
        {
          id: 'collect', title: 'Information we collect',
          body: (
            <>
              <p><b>Information you give us:</b> your name, email address, mobile number, delivery addresses, dietary notes, order and reservation details, messages to restaurants or support, reviews, and your account password (stored only as a secure hash).</p>
              <p><b>Payment information:</b> card details are entered into and stored by our payment processor. We receive only a token, the card brand, the last four digits and the expiry date. We never store full card numbers.</p>
              <p><b>Information collected automatically:</b> device and browser type, IP address, sign-in times, app push-notification tokens, and the pages and features you use. For deliveries we use the delivery address you provide; couriers share their location while they are on a delivery so you can track it.</p>
              <p><b>Restaurants and couriers:</b> if you run a restaurant or deliver with Gutad, we also collect business, tax, bank and identity-verification details needed to pay you and meet legal requirements.</p>
            </>
          ),
        },
        {
          id: 'use', title: 'How we use information',
          body: (
            <ul>
              <li>To take, prepare, deliver and support your orders, reservations and tickets.</li>
              <li>To send transactional messages by email, push notification and text message (see section 4).</li>
              <li>To process payments, refunds, gift cards, rewards and memberships.</li>
              <li>To keep accounts secure, prevent fraud and abuse, and meet legal, tax and accounting obligations.</li>
              <li>To improve our services and understand how they are used.</li>
              <li>To send marketing, only if you opt in. You can opt out at any time.</li>
            </ul>
          ),
        },
        {
          id: 'share', title: 'How we share information',
          body: (
            <>
              <p>We share personal information only as needed to provide the service:</p>
              <ul>
                <li><b>Restaurants</b> you order from or book with receive your name, order or booking details, and the contact details needed to fulfill it.</li>
                <li><b>Couriers and delivery partners</b> receive your name, delivery address, phone number and instructions.</li>
                <li><b>Service providers</b> that work on our behalf under contract, such as payment processing, hosting, email delivery, text message delivery, push notifications, mapping and customer support tools.</li>
                <li><b>Legal and safety:</b> when required by law, or to protect the rights, safety and property of our users, partners or Gutad.</li>
                <li><b>Business transfers:</b> as part of a merger, acquisition or sale of assets, subject to this policy.</li>
              </ul>
              <p><b>We do not sell your personal information.</b></p>
            </>
          ),
        },
        {
          id: 'sms', title: 'Mobile numbers and text messages',
          body: (
            <>
              <p>If you give us your mobile number, we use it to send you text messages about your orders, deliveries, reservations and account security, and to let restaurants and couriers reach you about an active order. Marketing texts are sent only if you separately opt in.</p>
              <p><b>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</b> Text messaging originator opt-in data and consent are not shared with any third parties, except the service providers that deliver our messages.</p>
              <p>Reply <b>STOP</b> to any text to stop receiving them, or <b>HELP</b> for help. You can also turn order and reservation texts off under Account → Notifications. Message and data rates may apply. See our <Link className="underline" href="/terms#sms">SMS terms</Link>.</p>
            </>
          ),
        },
        {
          id: 'choices', title: 'Your choices and rights',
          body: (
            <ul>
              <li><b>Notifications:</b> choose email, push and text settings for orders and reservations under Account → Notifications. Essential account and security messages are always sent.</li>
              <li><b>Marketing:</b> opt in or out of marketing email and marketing texts under Account → Profile at any time.</li>
              <li><b>Access:</b> download a copy of your data under Account → Privacy.</li>
              <li><b>Deletion:</b> request deletion of your account under Account → Privacy. We remove your name, contact details, addresses and saved cards after a short grace period. We keep receipts and payment records without your personal details where the law requires.</li>
              <li><b>Correction:</b> update your details under Account → Profile, or contact us.</li>
            </ul>
          ),
        },
        {
          id: 'retention', title: 'How long we keep information',
          body: <p>We keep personal information while your account is open and as long as needed to provide the service, resolve disputes, and meet legal, tax and accounting requirements. When it is no longer needed we delete or anonymize it.</p>,
        },
        {
          id: 'security', title: 'Security',
          body: <p>We protect information with encryption in transit, hashed passwords, optional two-step sign-in, access controls that limit staff access to what their role needs, and audit logs of sensitive actions. No system is perfectly secure, so please use a strong, unique password.</p>,
        },
        {
          id: 'cookies', title: 'Cookies and local storage',
          body: <p>We use browser storage to keep you signed in, remember your cart and preferences, and protect against abuse. We do not use third-party advertising cookies.</p>,
        },
        {
          id: 'children', title: 'Children',
          body: <p>Gutad is not intended for children under 13, and we do not knowingly collect their personal information. If you believe a child has given us information, contact us and we will delete it.</p>,
        },
        {
          id: 'changes', title: 'Changes to this policy',
          body: <p>We may update this policy. We will post the new version here with a new effective date and, for significant changes, notify you by email or in the app.</p>,
        },
        {
          id: 'contact', title: 'Contact us',
          body: <p>Gutad LLC. Email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with any privacy question or request.</p>,
        },
      ]}
    />
  );
}
