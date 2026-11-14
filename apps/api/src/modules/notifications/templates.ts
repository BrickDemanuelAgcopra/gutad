/** Message templates. Keep transactional copy short; SMS gets the first line only. */
export interface Rendered {
  subject: string;
  text: string;
  sms: string;
}

const money = (c?: number) => (typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : '');
const when = (d?: unknown) => (d ? new Date(d as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function render(template: string, p: Record<string, unknown>): Rendered {
  const sub = (s: string, t: string) => ({ subject: s, text: t, sms: t.split('\n')[0] });
  switch (template) {
    case 'account.recovery':
      return sub('Reset your Gutad password', `Use this link to reset your password (valid 24h): ${p.link}`);
    case 'order.submitted':
      return sub(`Order ${p.number} received`, `We've sent your order ${p.number} to the restaurant. You'll hear from us when it's confirmed.`);
    case 'order.accepted':
      return sub(`Order ${p.number} confirmed`, `The restaurant accepted order ${p.number}. Estimated ready: ${when(p.promiseAt)}.`);
    case 'order.rejected':
      return sub(`Order ${p.number} could not be accepted`, `Sorry — order ${p.number} was not accepted (${p.reason}). Your payment hold has been released.`);
    case 'order.ready':
      return sub(`Order ${p.number} is ready`, `Your order ${p.number} is ready${p.pickupCode ? ` — show code ${p.pickupCode} at the counter` : ''}.`);
    case 'order.collected':
      return sub(`Order ${p.number} picked up`, `Order ${p.number} has been collected. Enjoy!`);
    case 'order.completed':
      return sub(`Thanks for ordering (${p.number})`, `Your order ${p.number} is complete. Tap to rate your meal.`);
    case 'order.canceled':
      return sub(`Order ${p.number} canceled`, `Order ${p.number} was canceled (${p.reason}). Any captured payment is being refunded.`);
    case 'order.line_unavailable':
      return sub('One item needs your decision', `${p.name} is unavailable. Choose a replacement or take a credit in the app.`);
    case 'order.time_adjusted':
      return sub(`New time for ${p.number}`, `The restaurant updated your order ${p.number}: now ready around ${when(p.promiseAt)}.`);
    case 'payment.refunded':
      return sub('Refund issued', `A refund of ${money(p.amountCents as number)} has been issued. It may take 5–10 business days to appear.`);
    case 'delivery.assigned':
      return sub('Courier assigned', `A courier has been assigned to your order${p.driverName ? ` (${p.driverName})` : ''}.`);
    case 'delivery.picked_up':
      return sub('Your order is on the way', `Your courier has picked up the order. ETA ${when(p.etaAt)}.`);
    case 'delivery.delivered':
      return sub('Delivered', `Your order has been delivered${p.proofPhotoUrl ? ` — proof: ${p.proofPhotoUrl}` : ''}.`);
    case 'delivery.failed':
      return sub('Delivery problem', `We hit a problem delivering your order (${p.reason || 'unassigned'}). Support is on it.`);
    case 'delivery.late':
      return sub('Running late', `Your order is running later than planned. We'll keep you posted.`);
    case 'reservation.held':
      return sub('Complete your reservation', `Your table is held until ${when(p.holdExpiresAt)}. Add a card to confirm (code ${p.confirmationCode}).`);
    case 'reservation.confirmed':
      return sub(`Reservation confirmed — ${p.locationName}`, `Confirmed: ${p.locationName}, ${when(p.startAt)}. Confirmation ${p.confirmationCode}.`);
    case 'reservation.reminder':
      return sub(`Reminder: ${p.locationName} ${when(p.startAt)}`, `See you at ${p.locationName} on ${when(p.startAt)} (code ${p.confirmationCode}). Reply or tap to modify.`);
    case 'reservation.canceled':
      return sub('Reservation canceled', `Reservation ${p.confirmationCode} was canceled${p.late ? ' (late cancellation policy applied)' : ''}.`);
    case 'reservation.no_show':
      return sub('We missed you', `Reservation ${p.confirmationCode} was marked as a no-show.`);
    case 'waitlist.table_ready':
      return sub('Your table is ready', `${p.guestName}, your table is ready! Please check in within 10 minutes (by ${when(p.expiresAt)}).`);
    case 'waitlist.expired':
      return sub('Waitlist spot released', `Your waitlist spot was released. Rejoin any time.`);
    case 'ticket.confirmed':
      return sub(`Ticket confirmed: ${p.experience}`, `You're in: ${p.experience} on ${when(p.startAt)}. Code ${p.confirmationCode}${p.payAtVenue ? ' (pay at venue)' : ''}.`);
    case 'event.proposal_sent':
      return sub('Your private event proposal', `Proposal: ${money(p.proposalCents as number)} with a ${money(p.depositCents as number)} deposit. Valid until ${when(p.expiresAt)}.`);
    case 'group_order.cutoff':
      return sub('Group order cutoff reached', `Group order "${p.name}" is now locked and being submitted.`);
    case 'shipment.shipped':
      return sub(`Meal kit ${p.orderNumber} shipped`, `Shipped via ${p.carrier || 'carrier'}, tracking ${p.trackingNumber || 'pending'}.`);
    case 'payout.paid':
      return sub('Payout sent', `A payout of ${money(p.amountCents as number)} was sent to your bank account.`);
    case 'payout.failed':
      return sub('Payout failed', `Your payout failed: ${p.reason}. Please check your payout details.`);
    case 'membership.renewal_failed':
      return sub('Membership payment failed', `We couldn't renew your membership (attempt ${p.failures}). Update your card to keep benefits.`);
    case 'incident.resolved':
      return sub('Your support case is resolved', `Case resolved: ${p.remedy}${p.cents ? ` (${money(p.cents as number)})` : ''}${p.orderNumber ? ` for order ${p.orderNumber}` : ''}.`);
    case 'merchant.new_order':
      return sub(`New order ${p.number}`, `New order ${p.number} waiting for acceptance.`);
    case 'merchant.unacknowledged':
      return sub(`Unacknowledged order ${p.number}`, `Order ${p.number} has not been acknowledged. ${p.offline ? 'Your tablet appears offline. ' : ''}Please accept or reject it now.`);
    case 'campaign':
      return sub(String(p.subject || 'A note from your favorite restaurant'), String(p.body || ''));
    case 'order.message':
      return sub(`About your order ${p.number}`, String(p.body || ''));
    case 'ops.alert':
      return sub(`[${p.severity}] ${p.title}`, `${p.title}${p.detail ? `\n${p.detail}` : ''}${p.escalated ? `\nEscalated (level ${p.level}).` : ''}`);
    case 'document.expiring':
      return sub(p.expired ? `Your ${p.docType} has expired` : `Your ${p.docType} expires soon`, p.expired ? `Your ${p.docType} on file with Gutad has expired. Upload a current one in Onboarding to keep selling.` : `Your ${p.docType} expires on ${when(p.expiresAt)}. Upload the renewed document in Onboarding before then.`);
    case 'change.reviewed':
      return sub(p.approved ? 'Your change is live' : 'Your change was not approved', p.approved ? `Gutad approved: ${p.summary}.` : `Gutad did not approve: ${p.summary}. ${p.note || ''}`);
    case 'case.reply':
      return sub('Gutad support replied', `About your ${String(p.category).toLowerCase().replace(/_/g, ' ')} case: ${p.body}`);
    case 'recipe.changed':
      return sub(`Recipe updated: ${p.name} v${p.version}`, `${p.name} changed${p.summary ? `: ${p.summary}` : ''}. Read the new version and confirm on the kitchen screen.`);
    case 'approval.requested':
      return sub(`Approval needed: ${p.summary}`, `${p.requester} asked for approval: ${p.summary}${p.amountCents ? ` (${money(p.amountCents as number)})` : ''}. Reason: ${p.reason}. Review it in Admin → Approvals.`);
    case 'approval.decided':
      return sub(`Your request was ${String(p.status).toLowerCase()}`, `${p.summary} was ${String(p.status).toLowerCase()}${p.note ? `: ${p.note}` : ''}.`);
    case 'access.emergency':
      return sub('Emergency access activated', `${p.email} activated emergency access (${(p.roles as string[]).join(', ')}) until ${when(p.until)}. Reason: ${p.reason}. Review it in Admin → Staff & access.`);
    default:
      return sub(template, JSON.stringify(p));
  }
}
