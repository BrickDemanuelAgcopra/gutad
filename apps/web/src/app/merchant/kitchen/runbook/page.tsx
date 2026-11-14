'use client';
import { Button, Card } from '@/components/ui';

/** 13.8 offline / degraded-mode procedure. Print it and keep it at the pass. */
export default function KitchenRunbook() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden"><h1 className="text-2xl font-bold">Kitchen offline runbook</h1><Button onClick={() => window.print()}>Print</Button></div>
      <Card title="1. The screen still shows tickets (connection lost)">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>A red banner says the connection is lost. The queue shown is the last one this device saw.</li>
          <li>Keep bumping items as normal. Bumps are stored on this device and sent automatically when the connection returns.</li>
          <li>Press <b>Print tickets</b> on every station screen now, so you have paper if the screen goes blank.</li>
          <li>New orders cannot reach the kitchen while offline. Call the Gutad operations line so ordering can be paused for this location.</li>
        </ol>
      </Card>
      <Card title="2. Manual ticket mode (screens down)">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Work from the printed tickets. Write the time you start and finish on each ticket.</li>
          <li>Expo calls out each order when every station’s paper ticket is marked done.</li>
          <li>Pack from the paper ticket: tick each item, add utensils, napkins and anything on the checklist, write the bag count (1 of 2…).</li>
          <li>Hot and cold items go in separate bags. Mark allergy orders clearly in red.</li>
          <li>Put finished orders on the shelf and write the order number and shelf on the whiteboard.</li>
          <li>Hand pickup orders only to customers who show the 4-character pickup code; write the code on the ticket. Couriers: write the courier name.</li>
        </ol>
      </Card>
      <Card title="3. When the system is back">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Wait for the banner to clear and for saved actions to finish sending.</li>
          <li>For each paper ticket: bump remaining items, verify the bag and release it, and hand off with the code you wrote down.</li>
          <li>Record any remakes or missing items with a reason (“problem” on the item).</li>
          <li>Ask the operations line to resume ordering. Keep the paper tickets until the end of the shift.</li>
        </ol>
      </Card>
      <Card title="Safety">
        <p className="text-sm">Equipment safety controls are never bypassed from the Gutad screens. Faults go to the operations line; follow the manufacturer’s procedure for the equipment.</p>
      </Card>
    </div>
  );
}
