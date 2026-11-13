/**
 * Customer-facing order progress: one list of plain-language stages derived from the order status and,
 * for delivery orders, the courier job status. Shared by web and mobile so both show the same steps.
 */

export interface TrackingStage {
  key: string;
  label: string;
  done: boolean;
  current: boolean;
}

export interface TrackingInput {
  status: string;
  fulfillmentType: string;
  deliveryStatus?: string | null;
}

const ORDER_RANK: Record<string, number> = { SUBMITTED: 0, ACCEPTED: 0, PREPARING: 1, READY: 2, COLLECTED: 3, PARTIALLY_FULFILLED: 3, COMPLETED: 4 };

/** Returns null for orders that ended without fulfillment (rejected / canceled). */
export function trackingStages(o: TrackingInput): TrackingStage[] | null {
  if (o.status === 'REJECTED' || o.status === 'CANCELED') return null;
  const delivery = o.fulfillmentType === 'DELIVERY';
  const keys = delivery
    ? [['received', 'Order received'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['on_the_way', 'Courier on the way'], ['delivered', 'Delivered']]
    : [['received', 'Order received'], ['preparing', 'Preparing'], ['ready', 'Ready for pickup'], ['picked_up', 'Picked up']];
  let reached = ORDER_RANK[o.status] ?? 0;
  if (delivery) {
    const ds = o.deliveryStatus || '';
    if (ds === 'PICKED_UP') reached = Math.max(reached, 3);
    if (ds === 'DELIVERED') reached = 4;
    // order COLLECTED means the courier has the food; COMPLETED means it arrived
    if (o.status === 'COLLECTED' || o.status === 'PARTIALLY_FULFILLED') reached = Math.max(reached, 3);
    if (o.status === 'COMPLETED') reached = 4;
  } else if (o.status === 'COLLECTED' || o.status === 'COMPLETED') reached = 3;
  const allDone = reached >= keys.length - 1;
  return keys.map(([key, label], i) => ({ key, label, done: i < reached || (allDone && i === reached), current: i === reached && !allDone }));
}

/** One-line headline for the current stage, e.g. for a banner or push copy. */
export function trackingHeadline(o: TrackingInput): string {
  const stages = trackingStages(o);
  if (!stages) return o.status === 'REJECTED' ? 'The restaurant could not take this order' : 'Order canceled';
  const cur = stages.find((s) => s.current) || stages[stages.length - 1];
  return cur.label;
}
