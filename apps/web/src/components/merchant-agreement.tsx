/** Gutad Merchant Agreement text. Keep MERCHANT_AGREEMENT_VERSION in the API in step with this file. */
export const AGREEMENT_VERSION = '2026-11-13.2';

export const GUTAD_ENTITY = {
  name: 'Gutad LLC',
  form: 'a Wyoming limited liability company',
  address: '30 N Gould St Ste N, Sheridan, WY 82801',
};

const SECTIONS: [string, string[]][] = [
  ['1. Parties and acceptance', [
    `This Merchant Agreement (the "Agreement") is between ${GUTAD_ENTITY.name}, ${GUTAD_ENTITY.form} with its office at ${GUTAD_ENTITY.address} ("Gutad"), and the business named during onboarding in the Gutad merchant portal (the "Merchant").`,
    'The person who accepts this Agreement in the merchant portal confirms that they are authorized to bind the Merchant. Acceptance in the portal is an electronic signature and has the same effect as a handwritten one. The Agreement takes effect when it is accepted (the "Effective Date").',
  ]],
  ['2. Definitions', [
    '"Platform" means Gutad’s websites, apps, merchant portal, QR codes, embeddable widgets and related services. "Customer" means a person who places an order through the Platform. "Order" means a Customer’s request for food or other items from the Merchant made through the Platform. "Courier" means a person who collects and delivers Orders. "Order Form" means the commercial terms for the Merchant issued by Gutad and signed by the Merchant in the merchant portal, including any later version. "Merchant Content" means the Merchant’s names, logos, trademarks, menus, descriptions, photos and other materials provided to Gutad.',
  ]],
  ['3. The relationship', [
    'Gutad provides the Platform so Customers can find the Merchant and order from it. The Merchant prepares the food in its own kitchen, is the seller of the food, and remains responsible for it. The parties are independent contractors; nothing in this Agreement creates a partnership, joint venture, franchise, employment or agency relationship, except the limited payment collection role described in Section 9.',
  ]],
  ['4. Order Form', [
    'The Order Form sets the Merchant’s commercial terms, including commission by sales channel, any subscription fee, payment processing fees and the effective date. If this Agreement and the Order Form conflict, the Order Form controls for that subject. A new Order Form version applies only after the Merchant signs it; until then the last signed version applies.',
  ]],
  ['5. Onboarding, verification and activation', [
    'The Merchant will give Gutad accurate and complete business information and the documents Gutad requests, which may include a business license or registration, a food service or health permit, a tax form and identification of the owner or authorized signer. The Merchant will keep this information current and tell Gutad promptly about any change.',
    'Gutad reviews this information before activation and may decline or delay activation if it cannot verify the Merchant. A location appears to Customers only after Gutad verifies the operator. Gutad may repeat verification from time to time.',
  ]],
  ['6. Menus, prices and listings', [
    'The Merchant sets its own prices and is responsible for its menus, descriptions, customization options, allergen and dietary information and photos being accurate and lawful. The Merchant will mark items unavailable promptly and keep its hours and preparation times up to date.',
    'Gutad may format, organize and display Merchant Content to fit the Platform, and may remove or hide content that is inaccurate, unlawful or in breach of Gutad’s policies.',
  ]],
  ['7. Orders, preparation and handoff', [
    'The Merchant will accept or reject each Order promptly, prepare accepted Orders as described and within the stated preparation time, and package them so they are sealed, labeled with the Order details and suitable for transport. The Merchant will follow the pickup procedure agreed with Gutad so Couriers can collect Orders without undue waiting, and will hand Orders only to the Courier or Customer shown in the Platform.',
    'If an item is unavailable after acceptance, the Merchant will tell the Customer through the Platform so the Customer can accept a replacement or a credit.',
  ]],
  ['8. Delivery', [
    'Delivery Orders are carried by Couriers hired or contracted by Gutad, which may include third-party delivery providers. The Merchant may deliver Orders with its own staff only after Gutad expressly approves it through the merchant portal. If approved, the Merchant is responsible for its drivers, their conduct and vehicles, compliance with applicable law, and the insurance in Section 13, and must update delivery status in the Platform.',
  ]],
  ['9. Payments and payouts', [
    'Customers pay for Orders through the Platform; the Merchant will not request or accept cash or other payment for Platform Orders. The Merchant appoints Gutad as its limited agent to collect payments from Customers for Orders. A Customer’s payment to Gutad satisfies the Customer’s obligation to pay the Merchant for that Order. Payments are processed by third-party payment processors, and the Merchant may need to complete the processor’s onboarding to receive payouts.',
    'Gutad pays the Merchant weekly for completed Orders, minus commissions, fees, refunds, credits, chargebacks and other amounts described in this Agreement or the Order Form. Each payout comes with a statement. If the amounts owed to Gutad in a period exceed the Merchant’s earnings, the difference is deducted from later payouts, and Gutad may invoice any balance that remains after 60 days.',
    'Gutad may delay a payout while it investigates suspected fraud, a security issue, an unusual volume of disputes or missing payout information, and will tell the Merchant when it does. The Merchant has 60 days after a statement is issued to dispute it through the merchant portal; after that the statement is final, except for errors Gutad must correct by law.',
  ]],
  ['10. Refunds, cancellations and chargebacks', [
    'Gutad handles Customer support for Platform Orders and decides Customer remedies such as refunds, credits and replacements under its support policies. Who bears the cost follows who caused the problem: the Merchant bears refunds for missing, incorrect, poorly prepared or unsafe items and for Orders it fails to prepare; Gutad bears problems caused by Couriers it arranged or by the Platform. Chargebacks are handled the same way, and the Merchant will provide information Gutad reasonably requests to contest them.',
  ]],
  ['11. Taxes', [
    'Each party is responsible for its own income taxes. The Merchant is responsible for sales and similar taxes on its food unless the law requires Gutad, as a marketplace facilitator, to collect and remit them, in which case Gutad will do so for the Orders concerned. The Merchant will set accurate tax rates for its location in the merchant portal. Gutad may issue tax information returns (such as Form 1099-K) as the law requires.',
  ]],
  ['12. Food safety and compliance', [
    'The Merchant will hold and maintain all licenses and permits needed to prepare and sell its food, follow applicable food safety, allergen, labeling, alcohol, employment and consumer protection laws, and tell Gutad within two business days if a permit lapses or a regulator takes action against the location. The Merchant will tell Gutad immediately of any food recall or safety issue affecting Platform Orders and will cooperate in notifying affected Customers.',
  ]],
  ['13. Insurance', [
    'During the term the Merchant will maintain, with reputable insurers, commercial general liability insurance including products and completed operations coverage of at least $1,000,000 per occurrence and $2,000,000 in the aggregate, and workers’ compensation insurance as required by law. If Gutad approves the Merchant to deliver Orders with its own staff, the Merchant will also maintain automobile liability insurance of at least $1,000,000 combined single limit covering those deliveries. The Merchant will provide certificates of insurance on request.',
  ]],
  ['14. Intellectual property', [
    'The Merchant keeps ownership of Merchant Content. The Merchant grants Gutad a non-exclusive, royalty-free, worldwide license during the term to use, copy, display and adapt Merchant Content to list the Merchant, take and fulfill Orders and promote the Merchant on the Platform and in Gutad’s marketing. The Merchant confirms it has the rights needed to grant this license.',
    'Gutad keeps ownership of the Platform, its software, data, designs and trademarks. The Merchant may use Gutad’s name and logo only as Gutad provides or approves, for example on in-store signage or QR codes. Gutad may use suggestions the Merchant provides about the Platform without obligation.',
  ]],
  ['15. Customer information and security', [
    'The Merchant will use Customer information it receives through the Platform only to prepare, fulfill and support the related Orders, will not use it for marketing unless the Customer has opted in through the Platform, and will not sell it. The Merchant will protect that information with reasonable safeguards and tell Gutad without undue delay after learning of any unauthorized access to it. Gutad handles Customer information under its privacy policy.',
  ]],
  ['16. Confidentiality', [
    'Each party will keep the other’s non-public business information, including the Order Form terms, sales data and technical information, confidential, and use it only to perform this Agreement. This does not apply to information that is or becomes public through no fault of the receiving party, that the receiving party already had or develops independently, or that must be disclosed by law (with notice to the other party where the law allows).',
  ]],
  ['17. Representations and disclaimer', [
    'Each party represents that it is duly organized, has authority to enter into this Agreement, and will comply with applicable law in performing it.',
    'Gutad provides the Platform "as is" and "as available". Except as stated in this Agreement, Gutad makes no warranties, express or implied, including warranties of merchantability, fitness for a particular purpose or non-infringement, and does not guarantee any volume of Orders or uninterrupted availability.',
  ]],
  ['18. Indemnification', [
    'The Merchant will defend and indemnify Gutad and its members, managers, employees and agents against third-party claims, and related losses, damages, fines and reasonable attorneys’ fees, arising from the food or items the Merchant provides (including illness or allergic reaction), Merchant Content, deliveries made by the Merchant’s own staff, or the Merchant’s breach of this Agreement or of law.',
    'Gutad will defend and indemnify the Merchant against third-party claims, and related losses, damages, fines and reasonable attorneys’ fees, arising from a claim that the Platform infringes a third party’s intellectual property, from the negligence or misconduct of Couriers arranged by Gutad, or from Gutad’s breach of this Agreement or of law.',
    'The indemnified party will notify the other promptly of the claim, let the indemnifying party control the defense and settlement (no settlement may impose obligations on the indemnified party without its consent), and cooperate reasonably at the indemnifying party’s expense.',
  ]],
  ['19. Limitation of liability', [
    'Neither party is liable to the other for indirect, incidental, special, consequential or punitive damages, or for lost profits or revenue, even if advised that they were possible. Each party’s total liability arising out of this Agreement in any twelve-month period is limited to the commissions and fees the Merchant paid Gutad in the twelve months before the event giving rise to the claim.',
    'These limits do not apply to indemnification obligations, breach of confidentiality, amounts owed for Orders, payouts or fees, or liability that cannot be limited by law, including liability for gross negligence, willful misconduct or fraud.',
  ]],
  ['20. Term, suspension and termination', [
    'This Agreement continues until ended. Either party may end it for any reason with 30 days’ notice through the merchant portal. Either party may end it immediately if the other materially breaches it and does not cure the breach within 10 days after notice, or becomes insolvent.',
    'Gutad may pause or suspend a location immediately, without ending the Agreement, if a permit lapses, there is a credible food safety, fraud or security concern, or the Merchant repeatedly breaches Gutad’s policies. Gutad will tell the Merchant the reason and what is needed to restore the location.',
    'On termination, the Merchant will fulfill or cancel open Orders and honor confirmed reservations and events as Gutad directs, and the parties will settle all outstanding amounts in the final statement. Sections 9 through 11 and 14 through 23 survive termination as needed to give them effect.',
  ]],
  ['21. Changes to this Agreement', [
    'Gutad may update this Agreement. Gutad will give at least 30 days’ notice of material changes through the merchant portal, and the Merchant will be asked to accept the new version. If the Merchant does not accept, it may end this Agreement under Section 20 before the change takes effect; continuing to accept Orders after the effective date means the Merchant accepts the change.',
  ]],
  ['22. Governing law and disputes', [
    'This Agreement is governed by the laws of the State of Wyoming, without regard to its conflict of laws rules.',
    'The parties will first try to resolve any dispute in good faith by written notice and discussion for 30 days. If the dispute is not resolved, either party may bring it only in the state or federal courts located in Wyoming, and each party consents to the personal jurisdiction of those courts. Either party may bring a claim in small claims court where eligible, and may seek urgent injunctive relief in any court with jurisdiction.',
  ]],
  ['23. Notices and general terms', [
    `Notices to the Merchant may be given through the merchant portal or by email to the account owner. Legal notices to Gutad must be sent in writing to ${GUTAD_ENTITY.name}, ${GUTAD_ENTITY.address}, and are effective when received.`,
    'This Agreement, the Order Form and the policies referenced in them are the entire agreement between the parties on this subject and replace earlier agreements on it. The Merchant may not assign this Agreement without Gutad’s written consent; Gutad may assign it to an affiliate or to a successor in a merger or sale of its business. Neither party is liable for delays caused by events beyond its reasonable control. If any provision is unenforceable, the rest remains in effect. A failure to enforce a provision is not a waiver.',
  ]],
];

export function MerchantAgreementText() {
  return (
    <div className="space-y-3 text-sm text-ink-700">
      <p className="text-xs text-ink-500">Gutad Merchant Agreement · version {AGREEMENT_VERSION} · {GUTAD_ENTITY.name}</p>
      {SECTIONS.map(([h, ps]) => (
        <section key={h}>
          <h3 className="font-semibold text-ink-900">{h}</h3>
          {ps.map((p) => <p key={p.slice(0, 32)} className="mt-1">{p}</p>)}
        </section>
      ))}
    </div>
  );
}
