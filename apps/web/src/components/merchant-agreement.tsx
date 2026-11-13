/** Gutad Merchant Agreement text. Keep MERCHANT_AGREEMENT_VERSION in the API in step with this file. */
export const AGREEMENT_VERSION = '2026-11-13';

const SECTIONS: [string, string[]][] = [
  ['1. Scope', ['Gutad operates an online marketplace and ordering tools (web, apps, QR codes and embeddable widgets) through which customers order from the Merchant. The Merchant prepares food in its own kitchen and remains responsible for it.']],
  ['2. Order Form', ['Commercial terms, including commission by sales channel, any subscription, payment processing fees and the effective date, are set out in the Merchant’s Order Form. If this Agreement and the Order Form conflict, the Order Form controls. A new Order Form version takes effect only once the Merchant signs it in the merchant portal.']],
  ['3. Onboarding and activation', ['The Merchant provides accurate business information and the onboarding documents Gutad requests (such as a business license, food service permit, tax form and owner identification) and keeps them current. Gutad reviews them before activation. A location goes live only after Gutad verifies the operator.']],
  ['4. Menus and prices', ['The Merchant supplies and maintains its menus, prices, descriptions, customization options and allergen information, and marks items sold out promptly. Prices shown to customers must not be misleading.']],
  ['5. Orders, preparation and handoff', ['The Merchant accepts or rejects each order promptly, prepares it within the agreed preparation time, packages it so it is sealed and labeled for transport, and follows the pickup procedure agreed with Gutad so couriers can collect orders without delay.']],
  ['6. Delivery', ['Delivery orders are carried by couriers hired or contracted by Gutad. The Merchant may deliver orders with its own staff only with Gutad’s express approval, requested from Settings > Delivery in the merchant portal.']],
  ['7. Payments and payouts', ['Customers pay through Gutad; the Merchant does not accept cash for Gutad orders. Payments are processed by third-party payment processors. Gutad pays the Merchant weekly, after commissions, fees, refunds and other adjustments described in the Order Form. A negative balance (for example, a refund after a payout) is netted against later payouts.']],
  ['8. Food safety and compliance', ['The Merchant holds and maintains all permits and licenses required to prepare and sell food, complies with applicable food safety, labeling and tax laws, and tells Gutad promptly if a permit lapses.']],
  ['9. Customer information', ['The Merchant uses customer information received through Gutad only to fulfill and support the related orders and in line with the customer’s marketing choices.']],
  ['10. Suspension and termination', ['Either party may end this Agreement with notice through the merchant portal. Gutad may pause or suspend a location for policy, safety or payment reasons. Open orders, reservations and balances are settled before offboarding completes.']],
  ['11. Changes', ['Gutad may update this Agreement. The Merchant is asked to review and accept each new version in the merchant portal.']],
];

export function MerchantAgreementText() {
  return (
    <div className="space-y-3 text-sm text-ink-700">
      <p className="text-xs text-ink-500">Gutad Merchant Agreement · version {AGREEMENT_VERSION}</p>
      {SECTIONS.map(([h, ps]) => (
        <section key={h}>
          <h3 className="font-semibold text-ink-900">{h}</h3>
          {ps.map((p) => <p key={p.slice(0, 24)} className="mt-1">{p}</p>)}
        </section>
      ))}
    </div>
  );
}
