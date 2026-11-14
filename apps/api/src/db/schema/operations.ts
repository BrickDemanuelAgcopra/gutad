// Admin platform, phase I: inventory & procurement, food safety, workforce & equipment.
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';

// ───── 21 inventory ─────

/** 21.3 storage areas inside a kitchen or warehouse. */
export const storageAreas = pgTable('storage_areas', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('DRY'), // WAREHOUSE | DRY | COLD | FREEZER | KITCHEN
  minTempC: doublePrecision('min_temp_c'),
  maxTempC: doublePrecision('max_temp_c'),
  createdAt: createdAt(),
});

/** 21.3 / 21.5 / 22.5 lots: what arrived, from whom, when it expires, what is left. */
export const stockLots = pgTable('stock_lots', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  ingredientId: uuid('ingredient_id').notNull(),
  storageAreaId: uuid('storage_area_id'),
  supplierId: uuid('supplier_id'),
  purchaseOrderId: uuid('purchase_order_id'),
  transferId: uuid('transfer_id'),
  lotCode: text('lot_code').notNull(),
  receivedQty: doublePrecision('received_qty').notNull(),
  quantity: doublePrecision('quantity').notNull(),
  unitCostCents: integer('unit_cost_cents').notNull().default(0),
  receivedAt: ts('received_at').notNull(),
  expiresAt: ts('expires_at'),
  status: text('status').notNull().default('AVAILABLE'), // AVAILABLE | QUARANTINED | DEPLETED | WITHDRAWN | EXPIRED
  createdAt: createdAt(),
}, (t) => [index('stock_lots_kitchen_ing_idx').on(t.kitchenId, t.ingredientId, t.expiresAt)]);

/** 21.4 stock movements ledger (signed quantities in the ingredient's base unit). */
export const stockMovements = pgTable('stock_movements', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  ingredientId: uuid('ingredient_id').notNull(),
  lotId: uuid('lot_id'),
  kind: text('kind').notNull(), // RECEIPT | CONSUMPTION | TRANSFER_OUT | TRANSFER_IN | COUNT | ADJUSTMENT | SPOILAGE | WITHDRAWAL
  quantity: doublePrecision('quantity').notNull(),
  unitCostCents: integer('unit_cost_cents'),
  reason: text('reason'),
  orderId: uuid('order_id'),
  referenceId: uuid('reference_id'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('stock_movements_kitchen_idx').on(t.kitchenId, t.ingredientId, t.createdAt), index('stock_movements_lot_idx').on(t.lotId), index('stock_movements_order_idx').on(t.orderId)]);

/** 21.7 / 22.1 suppliers, approval and product specifications. */
export const suppliers = pgTable('suppliers', {
  id: id(),
  organizationId: uuid('organization_id'),
  name: text('name').notNull(),
  contactName: text('contact_name'),
  email: text('email'),
  phone: text('phone'),
  leadTimeDays: integer('lead_time_days').notNull().default(2),
  deliveryDays: integer('delivery_days').array().notNull().default([]),
  approved: boolean('approved').notNull().default(false),
  approvedById: uuid('approved_by_id'),
  approvedAt: ts('approved_at'),
  /** [{ ingredientId, spec, minTempC?, maxTempC?, shelfLifeDays? }] */
  specs: jsonb('specs').notNull().default([]),
  notes: text('notes'),
  createdAt: createdAt(),
});

/** 21.9 inter-site transfers: request → pick → ship → receive. */
export const stockTransfers = pgTable('stock_transfers', {
  id: id(),
  fromKitchenId: uuid('from_kitchen_id').notNull(),
  toKitchenId: uuid('to_kitchen_id').notNull(),
  status: text('status').notNull().default('REQUESTED'), // REQUESTED | PICKED | SHIPPED | RECEIVED | CANCELED
  /** [{ ingredientId, quantity, lots?: [{ lotId, quantity }], receivedQty? }] */
  lines: jsonb('lines').notNull().default([]),
  createdById: uuid('created_by_id'),
  pickedAt: ts('picked_at'),
  shippedAt: ts('shipped_at'),
  receivedAt: ts('received_at'),
  receivedById: uuid('received_by_id'),
  discrepancy: text('discrepancy'),
  createdAt: createdAt(),
});

// ───── 22 food safety ─────

/** 22.2 receiving and storage temperatures. */
export const temperatureLogs = pgTable('temperature_logs', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  storageAreaId: uuid('storage_area_id'),
  purchaseOrderId: uuid('purchase_order_id'),
  lotId: uuid('lot_id'),
  kind: text('kind').notNull(), // RECEIVING | STORAGE | HOT_HOLD | COOLING
  tempC: doublePrecision('temp_c').notNull(),
  minC: doublePrecision('min_c'),
  maxC: doublePrecision('max_c'),
  inRange: boolean('in_range').notNull(),
  note: text('note'),
  recordedById: uuid('recorded_by_id'),
  createdAt: createdAt(),
}, (t) => [index('temperature_logs_kitchen_idx').on(t.kitchenId, t.createdAt)]);

/** 22.3 checklist templates and signed completions. */
export const checklistTemplates = pgTable('checklist_templates', {
  id: id(),
  organizationId: uuid('organization_id'),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // OPENING | CLOSING | CLEANING | FOOD_HANDLING | CUSTOM
  frequency: text('frequency').notNull().default('DAILY'), // DAILY | SHIFT | WEEKLY
  /** [{ key, label, requiresValue? }] */
  items: jsonb('items').notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const checklistRuns = pgTable('checklist_runs', {
  id: id(),
  templateId: uuid('template_id').notNull(),
  kitchenId: uuid('kitchen_id'),
  locationId: uuid('location_id'),
  /** [{ key, done, value?, note? }] */
  answers: jsonb('answers').notNull().default([]),
  missedItems: integer('missed_items').notNull().default(0),
  signedName: text('signed_name').notNull(),
  completedById: uuid('completed_by_id'),
  completedAt: createdAt(),
});

/** 22.6 quarantine, withdrawal and recall. */
export const recalls = pgTable('recalls', {
  id: id(),
  title: text('title').notNull(),
  reason: text('reason').notNull(),
  severity: text('severity').notNull().default('HIGH'), // LOW | HIGH | CRITICAL
  ingredientId: uuid('ingredient_id'),
  supplierId: uuid('supplier_id'),
  lotIds: uuid('lot_ids').array().notNull().default([]),
  status: text('status').notNull().default('OPEN'), // OPEN | QUARANTINED | WITHDRAWN | CLOSED
  affectedMenuItemIds: uuid('affected_menu_item_ids').array().notNull().default([]),
  affectedOrderCount: integer('affected_order_count').notNull().default(0),
  customersNotifiedAt: ts('customers_notified_at'),
  createdById: uuid('created_by_id'),
  closedAt: ts('closed_at'),
  closedNote: text('closed_note'),
  createdAt: createdAt(),
});

/** 22.8 inspections and corrective actions (also raised from temperatures, checklists and incidents). */
export const inspections = pgTable('inspections', {
  id: id(),
  kitchenId: uuid('kitchen_id'),
  locationId: uuid('location_id'),
  kind: text('kind').notNull(), // INTERNAL | HEALTH_DEPT | THIRD_PARTY
  inspector: text('inspector').notNull(),
  score: integer('score'),
  result: text('result').notNull(), // PASS | CONDITIONAL | FAIL
  /** [{ code?, finding, severity }] */
  findings: jsonb('findings').notNull().default([]),
  reportUrl: text('report_url'),
  inspectedAt: ts('inspected_at').notNull(),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
});

export const correctiveActions = pgTable('corrective_actions', {
  id: id(),
  source: text('source').notNull(), // INSPECTION | TEMPERATURE | CHECKLIST | INCIDENT | RECALL
  sourceId: uuid('source_id'),
  kitchenId: uuid('kitchen_id'),
  locationId: uuid('location_id'),
  title: text('title').notNull(),
  ownerId: uuid('owner_id'),
  dueAt: ts('due_at'),
  status: text('status').notNull().default('OPEN'), // OPEN | DONE | VERIFIED
  evidenceUrl: text('evidence_url'),
  evidenceNote: text('evidence_note'),
  completedById: uuid('completed_by_id'),
  completedAt: ts('completed_at'),
  verifiedById: uuid('verified_by_id'),
  verifiedAt: ts('verified_at'),
  createdAt: createdAt(),
});

// ───── 23 workforce & equipment ─────

/** 23.1 shift schedules by location and station. */
export const staffShifts = pgTable('staff_shifts', {
  id: id(),
  locationId: uuid('location_id').notNull(),
  kitchenId: uuid('kitchen_id'),
  stationCode: text('station_code'),
  userId: uuid('user_id').notNull(),
  role: text('role'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  status: text('status').notNull().default('SCHEDULED'), // SCHEDULED | CANCELED
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('staff_shifts_loc_idx').on(t.locationId, t.startsAt)]);

/** 23.2 skills and certifications (e.g. GRILL, FOOD_HANDLER, ALLERGEN_TRAINED). */
export const staffSkills = pgTable('staff_skills', {
  userId: uuid('user_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  skill: text('skill').notNull(),
  certifiedAt: ts('certified_at').notNull(),
  expiresAt: ts('expires_at'),
  trainedById: uuid('trained_by_id'),
}, (t) => [primaryKey({ columns: [t.userId, t.organizationId, t.skill] })]);

/** 23.3 attendance. */
export const timeEntries = pgTable('time_entries', {
  id: id(),
  userId: uuid('user_id').notNull(),
  locationId: uuid('location_id').notNull(),
  kitchenId: uuid('kitchen_id'),
  shiftId: uuid('shift_id'),
  clockInAt: ts('clock_in_at').notNull(),
  clockOutAt: ts('clock_out_at'),
  breakMinutes: integer('break_minutes').notNull().default(0),
  rateCents: integer('rate_cents').notNull().default(0),
  approvedById: uuid('approved_by_id'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('time_entries_user_idx').on(t.userId, t.clockInAt), index('time_entries_loc_idx').on(t.locationId, t.clockInAt)]);

/** 23.5 / 23.6 / 23.8 equipment register (automated equipment is record/alert only — never actuated). */
export const equipment = pgTable('equipment', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // e.g. FRYER, GRILL, OVEN, FRIDGE, FREEZER, DISHWASHER, ROBOT_ARM, DISPENSER
  stationCode: text('station_code'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serial: text('serial'),
  isAutomated: boolean('is_automated').notNull().default(false),
  softwareVersion: text('software_version'),
  status: text('status').notNull().default('OK'), // OK | DEGRADED | DOWN | MAINTENANCE
  serviceIntervalDays: integer('service_interval_days'),
  lastServiceAt: ts('last_service_at'),
  nextServiceDueAt: ts('next_service_due_at'),
  /** what an outage changed, to restore it: { soldOutItemIds, stations: [{ id, maxConcurrent, isAvailable }] } */
  outageState: jsonb('outage_state'),
  createdAt: createdAt(),
});

export const equipmentTickets = pgTable('equipment_tickets', {
  id: id(),
  equipmentId: uuid('equipment_id').notNull(),
  kind: text('kind').notNull(), // FAULT | SERVICE | MAINTENANCE
  title: text('title').notNull(),
  detail: text('detail'),
  faultCode: text('fault_code'),
  status: text('status').notNull().default('OPEN'), // OPEN | IN_PROGRESS | RESOLVED
  vendor: text('vendor'),
  openedById: uuid('opened_by_id'),
  resolvedById: uuid('resolved_by_id'),
  resolvedAt: ts('resolved_at'),
  resolution: text('resolution'),
  createdAt: createdAt(),
});
