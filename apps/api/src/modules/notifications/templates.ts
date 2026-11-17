import { loadConfig } from '../../config/config';
import type { EmailBlocks } from './email-layout';

/**
 * Message templates. `text` is the in-app/plain-text body and SMS gets its first line only; keep transactional copy short.
 * `email` is the designed HTML body (see email-layout.ts); templates without it fall back to the text in the same layout.
 */
export interface Rendered {
  subject: string;
  text: string;
  sms: string;
  email?: EmailBlocks;
}

export interface RenderContext {
  /** Recipient address for this channel; used to build guest order links (`?email=`). */
  recipient?: string;
}

const money = (c?: number) => (typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : '');

/** "Nov 16, 2026, 1:43 PM EST" in the given IANA zone (falls back to the platform default for unknown zones). */
export function formatWhen(d: unknown, timeZone: string): string {
  if (!d) return '';
  const date = new Date(d as string);
  if (Number.isNaN(date.getTime())) return '';
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = loadConfig().DEFAULT_TIMEZONE; }
  const main = date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date).find((x) => x.type === 'timeZoneName')?.value;
  return abbr ? `${main} ${abbr}` : main;
}
const human = (s: unknown) => String(s ?? '').toLowerCase().replace(/_/g, ' ');

export function render(template: string, p: Record<string, unknown>, ctx: RenderContext = {}): Rendered {
  const cfg = loadConfig();
  const web = cfg.PUBLIC_WEB_URL.replace(/\/$/, '');
  // Times are shown in the restaurant's zone (resolved by NotificationsService from the location), else the platform default.
  const when = (d?: unknown) => formatWhen(d, (p.timezone as string) || cfg.DEFAULT_TIMEZONE);
  const sub = (s: string, t: string, email?: EmailBlocks): Rendered => ({ subject: s, text: t, sms: t.split('\n')[0], email });

  const topic = String(p.topic || '');
  const orderId = (p.orderId as string) || (topic.startsWith('order.') || template.startsWith('order.') ? (p.aggregateId as string) : '');
  const guestQs = ctx.recipient && ctx.recipient.includes('@') ? `?email=${encodeURIComponent(ctx.recipient)}` : '';
  const orderUrl = orderId ? `${web}/orders/${orderId}${guestQs}` : `${web}/account`;
  const orderCta = (label = 'View your order') => ({ label, url: orderUrl });
  const resUrl = p.confirmationCode ? `${web}/reservations/${encodeURIComponent(String(p.confirmationCode))}` : `${web}/account`;
  const num = p.number ? String(p.number) : '';

  switch (template) {
    case 'account.recovery':
      return sub('Reset your Gutad password', `Use this link to reset your password (valid 24h): ${p.link}`, {
        eyebrow: 'Account security', tone: 'neutral', heading: 'Reset your password',
        paragraphs: ['We received a request to reset the password for your Gutad account. Choose a new password with the button below.'],
        cta: { label: 'Choose a new password', url: String(p.link) },
        note: "This link works once and expires in 24 hours. If you didn't ask for this, you can ignore this email; your password won't change.",
      });

    // ── Orders ──────────────────────────────────────────────────────────────
    case 'order.submitted':
      // Gutad Chef Network: charged now, cooked to order on the chosen day
      if (p.chefName) return sub(`Order ${num} placed with ${p.chefName}`, `Gutad charged ${money(p.totalCents as number)} for order ${num}. ${p.chefName} will confirm by ${when(p.acceptBy)}; if not, you get a full refund automatically.`, {
        eyebrow: 'Order placed', heading: `${p.chefName} is cooking for you`,
        paragraphs: [`Your order is booked for ${when(p.scheduledFor)}. ${p.chefName} confirms by ${when(p.acceptBy)}; if they can't, we refund you in full automatically.`, p.freeCancelUntil ? `You can cancel for a full refund until ${when(p.freeCancelUntil)}.` : ''].filter(Boolean),
        details: [['Order', num], ['Chef', p.chefName as string], ['For', when(p.scheduledFor)], ['Charged', money(p.totalCents as number)], ['Sold by', 'Gutad']],
        cta: orderCta('View your order'),
      });
      return sub(`Order ${num} received`, `We've sent your order ${num} to the restaurant. You'll hear from us when it's confirmed.`, {
        eyebrow: 'Order received', heading: 'We’ve got your order',
        paragraphs: ["Your order is with the restaurant now. We'll let you know as soon as they confirm it."],
        details: [['Order', num], ['Restaurant', p.locationName as string], ['Total', money(p.totalCents as number)]],
        cta: orderCta('Track your order'),
      });
    case 'order.accepted':
      return sub(`Order ${num} confirmed`, `The restaurant accepted order ${num}. Estimated ready: ${when(p.promiseAt)}.`, {
        eyebrow: 'Confirmed', tone: 'success', heading: 'Your order is confirmed',
        paragraphs: ['The restaurant accepted your order and the kitchen is getting started.'],
        details: [['Order', num], ['Estimated ready', when(p.promiseAt)]],
        cta: orderCta('Track your order'),
      });
    case 'order.rejected':
      if (p.prepaid) return sub(`Order ${num} refunded`, `Sorry — order ${num} couldn't go ahead (${p.reason}). We refunded ${money(p.refundCents as number)} to your card.`, {
        eyebrow: 'Refunded', tone: 'danger', heading: 'Your order couldn’t go ahead',
        paragraphs: [`We're sorry. ${p.reason}. We refunded the full ${money(p.refundCents as number)} to your original payment method; it usually appears within 5–10 business days.`],
        details: [['Order', num], ['Refund', money(p.refundCents as number)]],
        cta: { label: 'Find another chef', url: `${web}/chefs` },
      });
      return sub(`Order ${num} could not be accepted`, `Sorry — order ${num} was not accepted (${p.reason}). Your payment hold has been released.`, {
        eyebrow: 'Not accepted', tone: 'danger', heading: 'Your order couldn’t be accepted',
        paragraphs: ["We're sorry. The restaurant couldn't take this order, so you have not been charged. The hold on your payment method has been released; your bank may take a few days to show it."],
        details: [['Order', num], ['Reason', human(p.reason)]],
        cta: { label: 'Find something else', url: web },
      });
    case 'order.ready':
      return sub(`Order ${num} is ready`, `Your order ${num} is ready${p.shelfSlot ? ` on shelf ${p.shelfSlot}` : ''}${p.pickupCode ? ` — show code ${p.pickupCode} at the counter` : ''}.`, {
        eyebrow: 'Ready', tone: 'success', heading: 'Your order is ready',
        paragraphs: [p.shelfSlot ? `Head to the pickup shelf; your order is on shelf ${p.shelfSlot}.` : 'Your order is ready to pick up.'],
        code: p.pickupCode ? { label: 'Pickup code', value: String(p.pickupCode) } : undefined,
        details: [['Order', num], ['Shelf', p.shelfSlot as string]],
        cta: orderCta(),
      });
    case 'recall.notice':
      return sub(`Important safety notice about order ${num}`, `${p.title}. ${p.message}`, {
        eyebrow: 'Safety notice', tone: 'danger', heading: String(p.title || 'Important safety notice'),
        paragraphs: [String(p.message || ''), 'If you still have this food, please do not eat it. Contact us and we will make it right.'],
        details: [['Order', num]],
        cta: orderCta('View order and get help'),
      });
    case 'order.pickup_reminder':
      return sub(`Your order ${num} is waiting`, `Order ${num} has been ready since ${when(p.readyAt)}. Please pick it up by ${when(p.holdUntil)}; after that it is ${p.resolution === 'REFUND' ? 'canceled and refunded' : 'treated as collected and not refunded'}.`, {
        eyebrow: 'Waiting for you', tone: 'warning', heading: 'Your order is waiting',
        paragraphs: [`Please pick it up by ${when(p.holdUntil)}. After that it is ${p.resolution === 'REFUND' ? 'canceled and refunded' : 'treated as collected and not refunded'}.`],
        code: p.pickupCode ? { label: 'Pickup code', value: String(p.pickupCode) } : undefined,
        details: [['Order', num], ['Ready since', when(p.readyAt)], ['Hold until', when(p.holdUntil)]],
        cta: orderCta(),
      });
    case 'order.collected':
      return sub(`Order ${num} picked up`, `Order ${num} has been collected. Enjoy!`, {
        eyebrow: 'Picked up', tone: 'success', heading: 'Enjoy your meal!',
        paragraphs: [`Order ${num} has been collected.`],
        cta: orderCta(),
      });
    case 'order.completed':
      return sub(`Thanks for ordering (${num})`, `Your order ${num} is complete. Tap to rate your meal.`, {
        eyebrow: 'Complete', tone: 'success', heading: 'Thanks for ordering',
        paragraphs: ['We hope you enjoyed it. A quick rating helps the restaurant and other diners.'],
        details: [['Order', num]],
        cta: orderCta('Rate your meal'),
      });
    case 'order.canceled':
      if (p.prepaid) return sub(`Order ${num} canceled`, `Order ${num} was canceled. Refund: ${money((p.refundCents as number) || 0)}.`, {
        eyebrow: 'Canceled', tone: 'danger', heading: 'Your order was canceled',
        paragraphs: [(p.refundCents as number) > 0 ? `We refunded ${money(p.refundCents as number)} to your original payment method; it usually appears within 5–10 business days.` : 'This cancellation came after the order cutoff, so under the terms you accepted at checkout no refund applies.'],
        details: [['Order', num], ['Refund', money((p.refundCents as number) || 0)]],
        cta: orderCta(),
      });
      return sub(`Order ${num} canceled`, `Order ${num} was canceled (${p.reason}). Any captured payment is being refunded.`, {
        eyebrow: 'Canceled', tone: 'danger', heading: 'Your order was canceled',
        paragraphs: ['Any payment we captured is being refunded to your original payment method. Refunds usually appear within 5–10 business days.'],
        details: [['Order', num], ['Reason', human(p.reason)]],
        cta: orderCta(),
      });
    case 'order.line_unavailable':
      return sub('One item needs your decision', `${p.name} is unavailable. Choose a replacement or take a credit in the app.`, {
        eyebrow: 'Action needed', tone: 'warning', heading: 'One item is unavailable',
        paragraphs: [`${p.name} is no longer available. Choose a replacement or take a credit so the kitchen can carry on with your order.`],
        details: [['Order', num], ['Item', p.name as string]],
        cta: orderCta('Choose an option'),
      });
    case 'order.time_adjusted':
      return sub(`New time for ${num}`, `The restaurant updated your order ${num}: now ready around ${when(p.promiseAt)}.`, {
        eyebrow: 'Updated time', tone: 'warning', heading: 'Your order has a new time',
        paragraphs: ['The restaurant updated when your order will be ready.'],
        details: [['Order', num], ['Now ready around', when(p.promiseAt)]],
        cta: orderCta('Track your order'),
      });
    case 'order.message':
      return sub(`About your order ${num}`, String(p.body || ''), {
        eyebrow: 'Message', heading: `About your order ${num}`, paragraphs: [String(p.body || '')], cta: orderCta(),
      });
    case 'payment.refunded':
      return sub('Refund issued', `A refund of ${money(p.amountCents as number)} has been issued. It may take 5–10 business days to appear.`, {
        eyebrow: 'Refund', tone: 'success', heading: `We’ve refunded ${money(p.amountCents as number)}`,
        paragraphs: ['The refund is on its way to your original payment method. It may take 5–10 business days to appear on your statement.'],
        details: [['Amount', money(p.amountCents as number)], ['Order', num]],
        cta: orderId ? orderCta() : undefined,
      });

    // ── Delivery ────────────────────────────────────────────────────────────
    case 'delivery.assigned':
      return sub('Courier assigned', `A courier has been assigned to your order${p.driverName ? ` (${p.driverName})` : ''}.`, {
        eyebrow: 'Courier assigned', heading: 'A courier is on it',
        paragraphs: [`${p.driverName ? `${p.driverName} will` : 'A courier will'} pick up your order as soon as it's ready.`],
        cta: orderCta('Track your delivery'),
      });
    case 'delivery.picked_up':
      return sub('Your order is on the way', `Your courier has picked up the order. ETA ${when(p.etaAt)}.`, {
        eyebrow: 'On the way', tone: 'success', heading: 'Your order is on the way',
        paragraphs: ['Your courier has picked up the order.'],
        details: [['Estimated arrival', when(p.etaAt)]],
        cta: orderCta('Track your delivery'),
      });
    case 'delivery.arrived':
      return sub('Your courier is here', 'Your courier has arrived with your order.', {
        eyebrow: 'Arrived', tone: 'success', heading: 'Your courier is here', paragraphs: ['Your courier has arrived with your order.'], cta: orderCta(),
      });
    case 'delivery.delivered':
      return sub('Delivered', `Your order has been delivered${p.proofPhotoUrl || p.proofSignature ? ' (proof of delivery recorded)' : ''}.`, {
        eyebrow: 'Delivered', tone: 'success', heading: 'Your order was delivered',
        paragraphs: [`Enjoy your meal!${p.proofPhotoUrl || p.proofSignature ? ' Proof of delivery was recorded.' : ''} If anything is wrong or missing, let us know from your order page.`],
        cta: orderCta('View order or report a problem'),
      });
    case 'delivery.attempt':
      return sub('Your courier is trying to reach you', `Your courier can’t complete the delivery (${human(p.kind)}). Please answer your phone or reply before ${when(p.waitUntil)}, or the order may be returned.`, {
        eyebrow: 'Action needed', tone: 'warning', heading: 'Your courier is trying to reach you',
        paragraphs: [`Your courier can't complete the delivery (${human(p.kind)}). Please answer your phone or reply before ${when(p.waitUntil)}, or the order may be returned.`],
        cta: orderCta(),
      });
    case 'delivery.failed':
      return sub('Delivery problem', `We hit a problem delivering your order (${p.reason || 'unassigned'}). Support is on it.`, {
        eyebrow: 'Delivery problem', tone: 'danger', heading: 'We hit a problem with your delivery',
        paragraphs: ['Our support team is already on it and will update you shortly.'],
        details: [['Reason', human(p.reason || 'unassigned')]],
        cta: orderCta(),
      });
    case 'delivery.late':
      return sub('Running late', `Your order is running later than planned. We'll keep you posted.`, {
        eyebrow: 'Running late', tone: 'warning', heading: 'Your order is running late',
        paragraphs: ["Sorry, it's taking longer than planned. We'll keep you posted."],
        details: [['New estimate', when(p.promiseAt || p.etaAt)]],
        cta: orderCta('Track your order'),
      });

    // ── Reservations, waitlist, events ──────────────────────────────────────
    case 'reservation.held':
      return sub('Complete your reservation', `Your table is held until ${when(p.holdExpiresAt)}. Add a card to confirm (code ${p.confirmationCode}).`, {
        eyebrow: 'Action needed', tone: 'warning', heading: 'Your table is on hold',
        paragraphs: [`Add a card before ${when(p.holdExpiresAt)} to confirm your reservation.`],
        details: [['Restaurant', p.locationName as string], ['When', when(p.startAt)], ['Party', p.partySize as number], ['Confirmation', p.confirmationCode as string]],
        cta: { label: 'Confirm reservation', url: resUrl },
      });
    case 'reservation.confirmed':
      return sub(`Reservation confirmed — ${p.locationName}`, `Confirmed: ${p.locationName}, ${when(p.startAt)}. Confirmation ${p.confirmationCode}.`, {
        eyebrow: 'Confirmed', tone: 'success', heading: 'Your table is booked',
        paragraphs: [`We look forward to seeing you at ${p.locationName}.`],
        code: p.confirmationCode ? { label: 'Confirmation', value: String(p.confirmationCode) } : undefined,
        details: [['Restaurant', p.locationName as string], ['When', when(p.startAt)], ['Party', p.partySize as number]],
        cta: { label: 'View or change reservation', url: resUrl },
      });
    case 'reservation.reminder':
      return sub(`Reminder: ${p.locationName} ${when(p.startAt)}`, `See you at ${p.locationName} on ${when(p.startAt)} (code ${p.confirmationCode}). Reply or tap to modify.`, {
        eyebrow: 'Reminder', heading: `See you soon at ${p.locationName}`,
        details: [['When', when(p.startAt)], ['Party', p.partySize as number], ['Confirmation', p.confirmationCode as string]],
        cta: { label: 'View or change reservation', url: resUrl },
        note: 'Plans changed? Changing or canceling ahead of time helps the restaurant offer your table to someone else.',
      });
    case 'reservation.canceled':
      return sub('Reservation canceled', `Reservation ${p.confirmationCode} was canceled${p.late ? ' (late cancellation policy applied)' : ''}.`, {
        eyebrow: 'Canceled', tone: 'neutral', heading: 'Your reservation was canceled',
        paragraphs: [p.late ? "The restaurant's late cancellation policy was applied." : 'Hope to see you another time.'],
        details: [['Confirmation', p.confirmationCode as string], ['Restaurant', p.locationName as string]],
        cta: { label: 'Book another table', url: web },
      });
    case 'reservation.no_show':
      return sub('We missed you', `Reservation ${p.confirmationCode} was marked as a no-show.`, {
        eyebrow: 'Missed reservation', tone: 'neutral', heading: 'We missed you',
        paragraphs: ['Your reservation was marked as a no-show. If you think this is a mistake, reply to this email.'],
        details: [['Confirmation', p.confirmationCode as string]],
      });
    case 'waitlist.table_ready':
      return sub('Your table is ready', `${p.guestName}, your table is ready! Please check in within 10 minutes (by ${when(p.expiresAt)}).`, {
        eyebrow: 'Table ready', tone: 'success', heading: `${p.guestName ? `${p.guestName}, your` : 'Your'} table is ready!`,
        paragraphs: [`Please check in with the host within 10 minutes (by ${when(p.expiresAt)}).`],
      });
    case 'waitlist.expired':
      return sub('Waitlist spot released', `Your waitlist spot was released. Rejoin any time.`, {
        eyebrow: 'Waitlist', tone: 'neutral', heading: 'Your waitlist spot was released', paragraphs: ['You can rejoin the waitlist any time.'],
      });
    case 'ticket.confirmed':
      return sub(`Ticket confirmed: ${p.experience}`, `You're in: ${p.experience} on ${when(p.startAt)}. Code ${p.confirmationCode}${p.payAtVenue ? ' (pay at venue)' : ''}.`, {
        eyebrow: 'You’re in', tone: 'success', heading: String(p.experience || 'Your ticket is confirmed'),
        code: p.confirmationCode ? { label: 'Ticket code', value: String(p.confirmationCode) } : undefined,
        details: [['When', when(p.startAt)], ['Payment', p.payAtVenue ? 'Pay at the venue' : 'Paid']],
        cta: { label: 'View ticket', url: resUrl },
      });
    case 'event.proposal_sent':
      return sub('Your private event proposal', `Proposal: ${money(p.proposalCents as number)} with a ${money(p.depositCents as number)} deposit. Valid until ${when(p.expiresAt)}.`, {
        eyebrow: 'Private event', heading: 'Your event proposal is ready',
        paragraphs: ['Thanks for thinking of us for your event. Here is the proposal.'],
        details: [['Total', money(p.proposalCents as number)], ['Deposit to confirm', money(p.depositCents as number)], ['Valid until', when(p.expiresAt)]],
        cta: p.link ? { label: 'Review proposal', url: String(p.link) } : undefined,
      });
    case 'group_order.cutoff':
      return sub('Group order cutoff reached', `Group order "${p.name}" is now locked and being submitted.`, {
        eyebrow: 'Group order', heading: 'Your group order is locked',
        paragraphs: [`"${p.name}" reached its cutoff and is being submitted to the restaurant.`],
        cta: orderId ? orderCta() : undefined,
      });
    case 'shipment.shipped':
      return sub(`Meal kit ${p.orderNumber} shipped`, `Shipped via ${p.carrier || 'carrier'}, tracking ${p.trackingNumber || 'pending'}.`, {
        eyebrow: 'Shipped', tone: 'success', heading: 'Your meal kit is on its way',
        details: [['Order', p.orderNumber as string], ['Carrier', (p.carrier as string) || 'Carrier'], ['Tracking', (p.trackingNumber as string) || 'Pending']],
        cta: p.trackingUrl ? { label: 'Track package', url: String(p.trackingUrl) } : undefined,
      });

    // ── Rewards, memberships, gift cards ────────────────────────────────────
    case 'membership.renewal_failed':
      return p.suspended
        ? sub('Membership paused', `We couldn't collect your membership payment after ${p.failures} tries, so benefits are paused. Update your card in Account → Rewards to restart.`, {
            eyebrow: 'Membership paused', tone: 'danger', heading: 'Your membership is paused',
            paragraphs: [`We couldn't collect your membership payment after ${p.failures} tries, so your benefits are paused. Update your card to restart them.`],
            cta: { label: 'Update payment method', url: `${web}/account` },
          })
        : sub('Membership payment failed', `We couldn't renew your membership (attempt ${p.failures}). We'll try again ${when(p.nextRetryAt)}; update your card in Account → Rewards to keep benefits.`, {
            eyebrow: 'Payment failed', tone: 'warning', heading: 'We couldn’t renew your membership',
            paragraphs: ['Update your card to keep your benefits.'],
            details: [['Attempt', p.failures as number], ['Next try', when(p.nextRetryAt)]],
            cta: { label: 'Update payment method', url: `${web}/account` },
          });
    case 'giftcard.delivered':
      return sub(`You've received a ${money(p.amountCents as number)} Gutad gift card`, `${p.from ? `${p.from} sent you` : 'You have'} a ${money(p.amountCents as number)} Gutad gift card${p.message ? `: "${p.message}"` : '.'}
Code: ${p.code}
Add it in Account → Rewards → Gift cards and use it at checkout.`, {
        eyebrow: 'Gift card', heading: `${p.from ? `${p.from} sent you` : 'You’ve received'} a ${money(p.amountCents as number)} gift card`,
        paragraphs: p.message ? [`“${p.message}”`] : [],
        code: { label: 'Gift card code', value: String(p.code || '') },
        cta: { label: 'Add it to your account', url: `${web}/account` },
        note: 'Add it under Account → Rewards → Gift cards, then use it at checkout.',
      });
    case 'referral.rewarded':
      return sub('Referral reward added', `${p.points} points were added to your account for a successful referral. Thanks for spreading the word!`, {
        eyebrow: 'Reward', tone: 'success', heading: `You earned ${p.points} points`,
        paragraphs: ['Someone you referred placed their first order. Thanks for spreading the word!'],
        cta: { label: 'See your rewards', url: `${web}/account` },
      });
    case 'challenge.completed':
      return sub(`Challenge complete: ${p.name}`, `Nice work! ${money(p.rewardCents as number)} in credit is in your account. Use it within ${p.expiresInDays} days.`, {
        eyebrow: 'Challenge complete', tone: 'success', heading: `${money(p.rewardCents as number)} credit unlocked`,
        paragraphs: [`Nice work completing “${p.name}”. Your credit is in your account. Use it within ${p.expiresInDays} days.`],
        cta: { label: 'Order now', url: web },
      });
    case 'incident.resolved':
      return sub('Your support case is resolved', `Case resolved: ${p.remedy}${p.cents ? ` (${money(p.cents as number)})` : ''}${p.orderNumber ? ` for order ${p.orderNumber}` : ''}.`, {
        eyebrow: 'Resolved', tone: 'success', heading: 'Your support case is resolved',
        paragraphs: ['Thanks for letting us know. Here is how we resolved it.'],
        details: [['Resolution', human(p.remedy)], ['Amount', money(p.cents as number)], ['Order', p.orderNumber as string]],
        cta: orderId ? orderCta() : { label: 'Your account', url: `${web}/account` },
      });
    case 'case.reply':
      return sub('Gutad support replied', `About your ${human(p.category)} case: ${p.body}`, {
        eyebrow: 'Support', heading: 'Gutad support replied', audience: 'merchant',
        paragraphs: [`About your ${human(p.category)} case:`, String(p.body || '')],
        cta: { label: 'Open the case', url: `${web}/merchant/support` },
      });
    case 'campaign':
      return sub(String(p.subject || 'A note from your favorite restaurant'), String(p.body || ''), {
        heading: String(p.subject || 'A note from your favorite restaurant'), paragraphs: String(p.body || '').split(/\n{2,}/),
        cta: { label: 'Order now', url: web },
        note: 'You can change which messages you get under Account → Notifications.',
      });

    // ── Merchants ───────────────────────────────────────────────────────────
    case 'merchant.new_order':
      return sub(`New order ${num}`, `New order ${num} waiting for acceptance.`, {
        audience: 'merchant', eyebrow: 'New order', heading: `New order ${num}`, paragraphs: ['A new order is waiting for you to accept it.'],
        cta: { label: 'Open orders', url: `${web}/merchant/orders` },
      });
    case 'merchant.unacknowledged':
      return sub(`Unacknowledged order ${num}`, `Order ${num} has not been acknowledged. ${p.offline ? 'Your tablet appears offline. ' : ''}Please accept or reject it now.`, {
        audience: 'merchant', eyebrow: 'Urgent', tone: 'danger', heading: `Order ${num} needs a response`,
        paragraphs: [`${p.offline ? 'Your tablet appears to be offline. ' : ''}Please accept or reject this order now so the customer isn't left waiting.`],
        cta: { label: 'Open orders', url: `${web}/merchant/orders` },
      });
    case 'payout.paid':
      return sub('Payout sent', `A payout of ${money(p.amountCents as number)} was sent to your bank account.`, {
        audience: 'merchant', eyebrow: 'Payout', tone: 'success', heading: `${money(p.amountCents as number)} is on its way`,
        paragraphs: ['A payout was sent to your bank account. It usually arrives within 1–3 business days.'],
        details: [['Amount', money(p.amountCents as number)], ['Period', p.period as string]],
        cta: { label: 'View statement', url: `${web}/merchant/finance` },
      });
    case 'payout.failed':
      return sub('Payout failed', `Your payout failed: ${p.reason}. Please check your payout details.`, {
        audience: 'merchant', eyebrow: 'Action needed', tone: 'danger', heading: 'Your payout failed',
        paragraphs: ['Please check your bank details so we can send it again.'],
        details: [['Amount', money(p.amountCents as number)], ['Reason', String(p.reason || '')]],
        cta: { label: 'Check payout details', url: `${web}/merchant/finance` },
      });
    case 'document.expiring':
      return sub(p.expired ? `Your ${p.docType} has expired` : `Your ${p.docType} expires soon`, p.expired ? `Your ${p.docType} on file with Gutad has expired. Upload a current one in Onboarding to keep selling.` : `Your ${p.docType} expires on ${when(p.expiresAt)}. Upload the renewed document in Onboarding before then.`, {
        audience: 'merchant', eyebrow: p.expired ? 'Expired' : 'Expiring soon', tone: p.expired ? 'danger' : 'warning',
        heading: p.expired ? `Your ${p.docType} has expired` : `Your ${p.docType} expires soon`,
        paragraphs: [p.expired ? 'Upload a current document to keep selling on Gutad.' : `Upload the renewed document before ${when(p.expiresAt)} to avoid any interruption.`],
        cta: { label: 'Upload document', url: `${web}/merchant/onboarding` },
      });
    case 'change.reviewed':
      return sub(p.approved ? 'Your change is live' : 'Your change was not approved', p.approved ? `Gutad approved: ${p.summary}.` : `Gutad did not approve: ${p.summary}. ${p.note || ''}`, {
        audience: 'merchant', eyebrow: p.approved ? 'Approved' : 'Not approved', tone: p.approved ? 'success' : 'danger',
        heading: p.approved ? 'Your change is live' : 'Your change was not approved',
        paragraphs: [String(p.summary || ''), ...(p.note ? [String(p.note)] : [])],
        cta: { label: 'Open dashboard', url: `${web}/merchant` },
      });
    case 'recipe.changed':
      return sub(`Recipe updated: ${p.name} v${p.version}`, `${p.name} changed${p.summary ? `: ${p.summary}` : ''}. Read the new version and confirm on the kitchen screen.`, {
        audience: 'merchant', eyebrow: 'Recipe update', heading: `${p.name} (version ${p.version})`,
        paragraphs: [`${p.summary ? `${p.summary}. ` : ''}Read the new version and confirm it on the kitchen screen.`],
        cta: { label: 'Read recipe', url: `${web}/merchant/recipes` },
      });

    // ── Staff, approvals, security ──────────────────────────────────────────
    case 'ops.alert':
      return sub(`[${p.severity}] ${p.title}`, `${p.title}${p.detail ? `\n${p.detail}` : ''}${p.escalated ? `\nEscalated (level ${p.level}).` : ''}`, {
        audience: 'staff', eyebrow: `${p.severity || 'Alert'}${p.escalated ? ` · escalated L${p.level}` : ''}`, tone: p.severity === 'CRITICAL' || p.severity === 'HIGH' ? 'danger' : 'warning',
        heading: String(p.title || 'Operations alert'), paragraphs: p.detail ? [String(p.detail)] : [],
        cta: { label: 'Open alerts', url: `${web}/admin/alerts` },
      });
    case 'approval.requested':
      return sub(`Approval needed: ${p.summary}`, `${p.requester} asked for approval: ${p.summary}${p.amountCents ? ` (${money(p.amountCents as number)})` : ''}. Reason: ${p.reason}. Review it in Admin → Approvals.`, {
        audience: 'staff', eyebrow: 'Approval needed', tone: 'warning', heading: String(p.summary || 'Approval needed'),
        details: [['Requested by', p.requester as string], ['Amount', money(p.amountCents as number)], ['Reason', p.reason as string]],
        cta: { label: 'Review request', url: `${web}/admin/approvals` },
      });
    case 'approval.decided':
      return sub(`Your request was ${human(p.status)}`, `${p.summary} was ${human(p.status)}${p.note ? `: ${p.note}` : ''}.`, {
        audience: 'staff', eyebrow: human(p.status), tone: p.status === 'APPROVED' ? 'success' : 'danger', heading: `Your request was ${human(p.status)}`,
        paragraphs: [String(p.summary || ''), ...(p.note ? [String(p.note)] : [])],
        cta: { label: 'View approvals', url: `${web}/admin/approvals` },
      });
    case 'access.emergency':
      return sub('Emergency access activated', `${p.email} activated emergency access (${(p.roles as string[]).join(', ')}) until ${when(p.until)}. Reason: ${p.reason}. Review it in Admin → Staff & access.`, {
        audience: 'staff', eyebrow: 'Security', tone: 'danger', heading: 'Emergency access activated',
        details: [['Who', p.email as string], ['Roles', ((p.roles as string[]) || []).join(', ')], ['Until', when(p.until)], ['Reason', p.reason as string]],
        cta: { label: 'Review access', url: `${web}/admin/security` },
        note: "If you don't recognize this, revoke the grant now and contact a superadmin.",
      });
    case 'security.alert':
      return sub(`[Security] ${p.title}`, `${p.title}${p.detail ? `\n${p.detail}` : ''}\nReview it in Admin → Users, roles & permissions → Alerts.`, {
        audience: 'staff', eyebrow: 'Security alert', tone: 'danger', heading: String(p.title || 'Security alert'),
        paragraphs: p.detail ? [String(p.detail)] : [],
        cta: { label: 'Review alert', url: `${web}/admin/iam` },
        note: "If this wasn't expected, suspend the account or end its sessions from the console.",
      });
    case 'staff.invite':
      return sub('You are invited to the Gutad control center', `${p.inviter || 'An administrator'} invited you to join Gutad${p.roles ? ` as ${p.roles}` : ''}. Set your password here (the link expires ${when(p.expiresAt)}): ${p.link}`, {
        audience: 'staff', eyebrow: 'Invitation', heading: 'Join the Gutad team',
        paragraphs: [`${p.inviter || 'An administrator'} invited you to the Gutad control center${p.roles ? ` as ${p.roles}` : ''}. Set your password to get started.`],
        cta: { label: 'Accept invitation', url: String(p.link) },
        note: `This link expires ${when(p.expiresAt)} and works once. If you weren't expecting it, ignore this email.`,
      });
    case 'access.request':
      return sub(`Access request: ${p.role}`, `${p.requester} asked for the ${p.role} role${p.hours ? ` for ${p.hours} hours` : ''}. Why: ${p.justification}. Decide in Admin → Users, roles & permissions → Requests.`, {
        audience: 'staff', eyebrow: 'Access request', tone: 'warning', heading: `${p.requester} requested ${p.role}`,
        details: [['Role', p.role as string], ['Duration', p.hours ? `${p.hours} hours` : 'Permanent'], ['Why', p.justification as string]],
        cta: { label: 'Review request', url: `${web}/admin/iam` },
      });
    case 'access.request.decided':
      return sub(`Your access request was ${human(p.status)}`, `Your request for ${p.role} was ${human(p.status)}${p.note ? `: ${p.note}` : ''}.`, {
        audience: 'staff', eyebrow: human(p.status), tone: p.status === 'APPROVED' ? 'success' : 'danger', heading: `Your access request was ${human(p.status)}`,
        details: [['Role', p.role as string], ['Note', p.note as string]],
        cta: { label: 'Open the console', url: `${web}/admin` },
      });
    // ── Chef Network ────────────────────────────────────────────────────────
    case 'chef.application.received':
      return sub('We received your Gutad chef application', 'Thanks for applying to the Gutad Chef Network. Our team reviews your kitchen, documents and first menu, usually within 3 business days.', {
        eyebrow: 'Chef Network', heading: 'Application received',
        paragraphs: ['Thanks for applying to the Gutad Chef Network. Our team now reviews your kitchen, documents and first menu. This usually takes about 3 business days.', 'We will email you if we need anything else.'],
        cta: { label: 'View your application', url: `${web}/chefs/apply` },
      });
    case 'chef.application.changes':
      return sub('Your chef application needs a few changes', `Please update: ${p.steps}. Note from our team: ${p.note}`, {
        eyebrow: 'Chef Network', tone: 'warning', heading: 'A few changes are needed',
        paragraphs: ['Our reviewers need a few corrections before they can continue.'],
        details: [['Steps to update', p.steps as string], ['Note', p.note as string]],
        cta: { label: 'Update your application', url: `${web}/chefs/apply` },
      });
    case 'chef.application.approved':
      return sub('Welcome to the Gutad Chef Network', `Your application is approved. Connect payouts and open your availability to start selling as ${p.displayName}.`, {
        eyebrow: 'Chef Network', tone: 'success', heading: `Welcome, ${p.displayName || 'Chef'}`,
        paragraphs: ['Your application is approved. Next: connect payouts securely, add your dishes and open your availability.'],
        cta: { label: 'Open your chef dashboard', url: `${web}/chef` },
      });
    case 'chef.application.rejected':
      return sub('About your Gutad chef application', `We could not approve your application: ${p.reason}. You can appeal from your application page.`, {
        eyebrow: 'Chef Network', tone: 'danger', heading: 'We could not approve your application',
        details: [['Reason', p.reason as string]],
        paragraphs: ['If you think this is a mistake or your situation has changed, you can appeal from your application page.'],
        cta: { label: 'View or appeal', url: `${web}/chefs/apply` },
      });
    case 'chef.application.waitlisted':
      return sub('You are on the Gutad Chef Network waitlist', `Gutad is not onboarding chefs in your area yet${p.reason ? ` (${p.reason})` : ''}. We saved your application and will contact you when we open.`, {
        eyebrow: 'Chef Network', heading: 'You are on our waitlist',
        paragraphs: ['We are not onboarding chefs in your area yet. Your application is saved and we will contact you as soon as we open.'],
        cta: { label: 'View your application', url: `${web}/chefs/apply` },
      });

    // ── Chef Network operations ─────────────────────────────────────────────
    case 'chef.document.expiring':
      return sub(`Your ${p.label} expires in ${p.days} days`, `Your ${p.label} expires ${when(p.expiresAt)}. Upload the renewed document so your dishes stay on Gutad.`, {
        eyebrow: 'Chef Network', tone: 'warning', heading: `Renew your ${p.label}`,
        paragraphs: [`Your ${p.label} expires ${when(p.expiresAt)}.`, 'Upload the renewed document now. If a required document expires, your listings pause until we approve the renewal.'],
        cta: { label: 'Upload a renewal', url: `${web}/chef/compliance` },
      });
    case 'chef.document.expired':
      return sub(`Your ${p.labels} expired`, p.paused ? `Your ${p.labels} expired, so your Gutad listings are paused. Upload a renewal to reopen.` : `Your ${p.labels} expired. Upload a renewal.`, {
        eyebrow: 'Chef Network', tone: 'danger', heading: p.paused ? 'Your listings are paused' : 'A document expired',
        paragraphs: [`Your ${p.labels} expired.`, p.paused ? 'Your dishes are hidden and no new orders come in. Orders already placed are not affected. Upload the renewed document; we reopen your account as soon as it is approved.' : 'Upload the renewed document as soon as you can.'],
        cta: { label: 'Upload a renewal', url: `${web}/chef/compliance` },
      });
    case 'chef.document.renewed':
      return sub('Your documents are approved', 'Your renewed documents are approved and your chef account is active again. Turn your availability back on to take orders.', {
        eyebrow: 'Chef Network', tone: 'success', heading: 'You’re cleared to cook again',
        paragraphs: ['Your renewed documents are approved and your account is active again.', 'Turn your availability back on from your dashboard to start taking orders.'],
        cta: { label: 'Open your dashboard', url: `${web}/chef` },
      });
    case 'chef.quality.action':
      return sub(`Gutad quality update: ${p.label}`, String(p.note || ''), {
        eyebrow: 'Chef Network', tone: ['DISH_REINSTATED', 'CHEF_REINSTATED'].includes(String(p.kind)) ? 'success' : 'warning', heading: String(p.label || 'Quality update'),
        paragraphs: [String(p.note || ''), ['DISH_REINSTATED', 'CHEF_REINSTATED'].includes(String(p.kind)) ? 'Thanks for working with us on this.' : 'Reply to this email or contact Gutad chef support if you have questions or want to share your side.'],
        cta: { label: 'View your quality record', url: `${web}/chef/compliance` },
      });

    // ── Chef Network special requests ───────────────────────────────────────
    case 'chef.request.new':
    case 'chef.request.reminder':
    case 'chef.request.quoted':
    case 'chef.request.question':
    case 'chef.request.message':
    case 'chef.request.revision':
    case 'chef.request.accepted':
    case 'chef.request.declined':
    case 'chef.request.withdrawn':
    case 'chef.request.expired':
    case 'chef.request.closed': {
      const forChef = p.audience === 'chef';
      const url = `${web}${forChef ? '/chef/requests/' : '/account/requests/'}${p.requestId}`;
      const code = String(p.code || '');
      const dish = String(p.dishTitle || 'your dish');
      const chef = String(p.chefName || 'The chef');
      const ymd = (p.serviceDate || p.requestedDate) as string | undefined;
      const day = ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
      const cta = { label: forChef ? 'Open the request' : 'View your request', url };
      const details: [string, string][] = [['Request', code], ['Dish', dish]];
      const total = money(p.totalCents as number);
      switch (template) {
        case 'chef.request.new':
          return sub(`New special request ${code}`, `A customer asked for a change to ${dish} for ${day}. Reply by ${when(p.respondBy)}.`, { eyebrow: 'Chef Network', heading: 'New special request', paragraphs: [`A customer asked for a change to ${dish} for ${day}.`, `Quote it, suggest an alternative, ask a question or decline by ${when(p.respondBy)}. Unanswered requests expire.`], details, cta });
        case 'chef.request.reminder':
          return sub(`Reminder: special request ${code} needs your reply`, `A customer is waiting on ${code} for ${dish}. Reply by ${when(p.respondBy)} or it expires.`, { eyebrow: 'Chef Network', tone: 'warning', heading: 'A customer is waiting on you', paragraphs: [`Special request ${code} for ${dish} (${day}) still needs an answer.`, `Quote it, suggest an alternative, ask a question or decline by ${when(p.respondBy)}. Unanswered requests expire and count against your response time.`], details, cta });
        case 'chef.request.quoted':
          return sub(`${chef} quoted your request: ${total}`, `${chef} quoted ${total} for ${day}${p.kind === 'ALTERNATIVE' ? ' (a suggested alternative)' : ''}. Accept by ${when(p.quoteExpiresAt)}.`, { eyebrow: 'Chef Network', tone: 'success', heading: p.kind === 'ALTERNATIVE' ? `${chef} suggested an alternative` : `${chef} sent you a quote`, paragraphs: [`Total ${total} for ${day}. The price is confirmed by the chef and sold by Gutad.`, `Accept and pay by ${when(p.quoteExpiresAt)}, or ask for a revision.`], details: [...details, ['Quote', `v${p.version}`], ['Total', total]], cta: { label: 'Review the quote', url } });
        case 'chef.request.question':
          return sub(`${chef} has a question about ${code}`, `${chef}: ${p.body}`, { eyebrow: 'Chef Network', heading: `${chef} has a question`, paragraphs: [String(p.body || ''), `Reply by ${when(p.respondBy)} so ${chef} can quote it.`], details, cta: { label: 'Reply', url } });
        case 'chef.request.message':
          return sub(`New message on ${code}`, `${p.from ? `From ${p.from}: ` : ''}${p.body}`, { eyebrow: 'Chef Network', heading: 'New message on your request', paragraphs: [String(p.body || '')], details, cta });
        case 'chef.request.revision':
          return sub(`Revision requested on ${code}`, `The customer asked for a new version: ${p.body}`, { eyebrow: 'Chef Network', tone: 'warning', heading: 'The customer asked for a revision', paragraphs: [String(p.body || ''), `Send a new quote by ${when(p.respondBy)}.`], details, cta });
        case 'chef.request.accepted':
          return sub(`Quote accepted on ${code}`, `The customer accepted your quote (${total}, ${day}). You’ll get the order once they pay.`, { eyebrow: 'Chef Network', tone: 'success', heading: 'Your quote was accepted', paragraphs: [`The customer accepted ${total} for ${day}. The order arrives in your inbox once they pay.`], details, cta });
        case 'chef.request.declined':
          return sub(`${chef} can’t make your request ${code}`, `${chef} declined: ${p.reason}`, { eyebrow: 'Chef Network', tone: 'danger', heading: `${chef} can’t make this one`, paragraphs: [String(p.reason || ''), 'You can still order the dish as listed, or ask another chef.'], details, cta: { label: 'Browse chefs', url: `${web}/chefs` } });
        case 'chef.request.withdrawn':
          return sub(`Request ${code} withdrawn`, `The customer withdrew the request${p.reason ? `: ${p.reason}` : ''}.`, { eyebrow: 'Chef Network', heading: 'Request withdrawn', paragraphs: [`The customer withdrew this request${p.reason ? `: ${p.reason}` : ''}. Nothing else to do.`], details, cta });
        case 'chef.request.expired':
          return sub(`Request ${code} expired`, String(p.reason || 'The request expired.'), { eyebrow: 'Chef Network', tone: 'warning', heading: 'Request expired', paragraphs: [String(p.reason || 'The request expired.'), forChef ? 'Answering quickly keeps your response rate up.' : 'Nothing was charged. You can send a new request any time.'], details, cta });
        default:
          return sub(`Request ${code} closed by Gutad`, String(p.reason || ''), { eyebrow: 'Chef Network', heading: 'Request closed by Gutad', paragraphs: [String(p.reason || ''), 'Nothing was charged.'], details, cta });
      }
    }
    default:
      return sub(template, JSON.stringify(p));
  }
}

/** Representative payloads for previews and test sends (Admin → Settings → Messaging). */
export const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
  'account.recovery': { link: 'https://gutad.io/account/recover?token=sample' },
  'chef.application.received': { displayName: 'Chef Carlos', region: 'NY' },
  'chef.application.changes': { steps: 'Documents, First menu', note: 'Upload a current food handler card and add allergens to your lasagna.' },
  'chef.application.approved': { displayName: 'Chef Carlos' },
  'chef.application.rejected': { reason: 'The kitchen permit does not cover meals prepared for sale.' },
  'chef.application.waitlisted': { reason: 'not open in WY yet' },
  'chef.document.expiring': { label: 'Food handler card', days: 30, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  'chef.document.expired': { labels: 'Food handler card', paused: true },
  'chef.document.renewed': {},
  'chef.quality.action': { kind: 'DISH_SUSPENDED', label: 'Dish suspended', note: 'Food-safety report: Spaghetti suspended pending review' },
  'chef.request.reminder': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', respondBy: new Date(Date.now() + 6 * 3_600_000).toISOString(), audience: 'chef' },
  'chef.request.new': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', respondBy: new Date(Date.now() + 86_400_000).toISOString(), audience: 'chef' },
  'chef.request.quoted': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', totalCents: 3800, version: 2, kind: 'QUOTE', quoteExpiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), serviceDate: '2026-11-28', audience: 'customer' },
  'chef.request.question': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', body: 'Is the shrimp for an allergy-free table, or just a preference?', respondBy: new Date(Date.now() + 3 * 86_400_000).toISOString(), audience: 'customer' },
  'chef.request.message': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', body: 'Sounds good, thank you!', from: 'the customer', audience: 'chef' },
  'chef.request.revision': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', body: 'Could you make it for 4 instead of 2?', respondBy: new Date(Date.now() + 86_400_000).toISOString(), audience: 'chef' },
  'chef.request.accepted': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', totalCents: 3800, serviceDate: '2026-11-28', audience: 'chef' },
  'chef.request.declined': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', reason: 'I can’t source fresh shrimp that week.', audience: 'customer' },
  'chef.request.withdrawn': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', reason: 'Plans changed', audience: 'chef' },
  'chef.request.expired': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', reason: 'The chef didn’t answer in time', audience: 'customer' },
  'chef.request.closed': { requestId: 'sample', code: 'R-7F3K2A', dishTitle: 'Gutad’s Spaghetti — by Chef Carlos', chefName: 'Chef Carlos', requestedDate: '2026-11-28', reason: 'Duplicate request', audience: 'customer' },
  'order.submitted': { number: 'G-10482', locationName: 'Mama Put Kitchen', totalCents: 2840, orderId: 'sample' },
  'order.accepted': { number: 'G-10482', promiseAt: new Date(Date.now() + 25 * 60_000).toISOString(), orderId: 'sample' },
  'order.rejected': { number: 'G-10482', reason: 'KITCHEN_CLOSED', orderId: 'sample' },
  'order.ready': { number: 'G-10482', shelfSlot: 'B3', pickupCode: '4821', orderId: 'sample' },
  'recall.notice': { number: 'G-10482', title: 'Possible undeclared peanuts in the satay sauce', message: 'A supplier told us a batch of sauce may contain peanuts.', orderId: 'sample' },
  'order.pickup_reminder': { number: 'G-10482', readyAt: new Date(Date.now() - 20 * 60_000).toISOString(), holdUntil: new Date(Date.now() + 40 * 60_000).toISOString(), resolution: 'REFUND', pickupCode: '4821', orderId: 'sample' },
  'order.collected': { number: 'G-10482', orderId: 'sample' },
  'order.completed': { number: 'G-10482', orderId: 'sample' },
  'order.canceled': { number: 'G-10482', reason: 'CUSTOMER_REQUEST', orderId: 'sample' },
  'order.line_unavailable': { number: 'G-10482', name: 'Jollof rice (large)', orderId: 'sample' },
  'order.time_adjusted': { number: 'G-10482', promiseAt: new Date(Date.now() + 45 * 60_000).toISOString(), orderId: 'sample' },
  'order.message': { number: 'G-10482', body: 'We added an extra side of plantain on the house. Enjoy!', orderId: 'sample' },
  'payment.refunded': { amountCents: 1250, number: 'G-10482', orderId: 'sample' },
  'delivery.assigned': { driverName: 'Ade', orderId: 'sample' },
  'delivery.picked_up': { etaAt: new Date(Date.now() + 18 * 60_000).toISOString(), orderId: 'sample' },
  'delivery.arrived': { orderId: 'sample' },
  'delivery.delivered': { proofPhotoUrl: 'x', orderId: 'sample' },
  'delivery.attempt': { kind: 'NO_ANSWER', waitUntil: new Date(Date.now() + 10 * 60_000).toISOString(), orderId: 'sample' },
  'delivery.failed': { reason: 'VEHICLE_ISSUE', orderId: 'sample' },
  'delivery.late': { promiseAt: new Date(Date.now() + 30 * 60_000).toISOString(), orderId: 'sample' },
  'reservation.held': { locationName: 'Ember & Oak', startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), partySize: 4, confirmationCode: 'K7Q2PX', holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
  'reservation.confirmed': { locationName: 'Ember & Oak', startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), partySize: 4, confirmationCode: 'K7Q2PX' },
  'reservation.reminder': { locationName: 'Ember & Oak', startAt: new Date(Date.now() + 86_400_000).toISOString(), partySize: 4, confirmationCode: 'K7Q2PX' },
  'reservation.canceled': { confirmationCode: 'K7Q2PX', locationName: 'Ember & Oak', late: false },
  'reservation.no_show': { confirmationCode: 'K7Q2PX' },
  'waitlist.table_ready': { guestName: 'Chidi', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  'waitlist.expired': {},
  'ticket.confirmed': { experience: "Chef's table: West African tasting menu", startAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), confirmationCode: 'T9M4RA', payAtVenue: false },
  'event.proposal_sent': { proposalCents: 185000, depositCents: 50000, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  'group_order.cutoff': { name: 'Friday team lunch' },
  'shipment.shipped': { orderNumber: 'K-2209', carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
  'membership.renewal_failed': { failures: 2, nextRetryAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), suspended: false },
  'giftcard.delivered': { amountCents: 5000, from: 'Amara', message: 'Happy birthday! Dinner is on me.', code: 'GUTA-D7KQ-29XF' },
  'referral.rewarded': { points: 500 },
  'challenge.completed': { name: 'Try 3 new kitchens', rewardCents: 1000, expiresInDays: 30 },
  'incident.resolved': { remedy: 'PARTIAL_REFUND', cents: 650, orderNumber: 'G-10482', orderId: 'sample' },
  'case.reply': { category: 'PAYOUT_QUESTION', body: 'Your March payout was delayed by a bank holiday. It will arrive tomorrow.' },
  campaign: { subject: 'Weekend special: 20% off family platters', body: 'This weekend only, family platters are 20% off at Mama Put Kitchen.' },
  'merchant.new_order': { number: 'G-10482' },
  'merchant.unacknowledged': { number: 'G-10482', offline: true },
  'payout.paid': { amountCents: 482350, period: 'Nov 3 – Nov 9' },
  'payout.failed': { amountCents: 482350, reason: 'Account closed' },
  'document.expiring': { docType: 'food handler certificate', expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), expired: false },
  'change.reviewed': { approved: true, summary: 'New dinner menu (12 items)' },
  'recipe.changed': { name: 'Suya spice blend', version: 4, summary: 'Less cayenne, more ground peanut' },
  'ops.alert': { severity: 'HIGH', title: '3 orders stuck at Lekki kitchen', detail: 'Oldest is 34 minutes past its promise time.', escalated: true, level: 2 },
  'approval.requested': { requester: 'support.lead@gutad.io', summary: 'Refund order G-10482', amountCents: 8400, reason: 'Wrong order delivered' },
  'approval.decided': { status: 'APPROVED', summary: 'Refund order G-10482', note: 'Approved, customer has a clean history.' },
  'access.emergency': { email: 'oncall@gutad.io', roles: ['PLATFORM_ADMIN'], until: new Date(Date.now() + 4 * 3_600_000).toISOString(), reason: 'Payments outage, incident #212' },
  'security.alert': { title: 'Suspicious sign-in for finance@gutad.io', detail: 'Signed in from a network not seen in the last 30 days (203.0.113.7).' },
  'staff.invite': { inviter: 'admin@gutad.io', roles: 'Support', link: 'https://gutad.io/account/invite?token=sample', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  'access.request': { requester: 'ops@gutad.io', role: 'Finance', hours: 8, justification: 'Month-end close support' },
  'access.request.decided': { status: 'APPROVED', role: 'Finance', note: 'Granted for today only.' },
};
