CREATE TABLE "packaged_products" (
	"menu_item_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sku" text,
	"gtin" text,
	"brand_name" text,
	"size" double precision,
	"size_uom" text,
	"unit_count" integer DEFAULT 1 NOT NULL,
	"category" text DEFAULT 'OTHER' NOT NULL,
	"storage" text DEFAULT 'AMBIENT' NOT NULL,
	"date_type" text DEFAULT 'BEST_BEFORE' NOT NULL,
	"min_remaining_days" integer,
	"ingredients_text" text,
	"country_of_origin" text,
	"label_image_url" text,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"review_status" text DEFAULT 'DRAFT' NOT NULL,
	"review_note" text,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"expires_on" date,
	"received_qty" integer NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"supplier_name" text,
	"received_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_lots_qty_ck" CHECK ("product_lots"."reserved" >= 0 AND "product_lots"."on_hand" >= "product_lots"."reserved")
);
--> statement-breakpoint
CREATE TABLE "product_recalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"organization_id" uuid,
	"menu_item_id" uuid,
	"gtin" text,
	"lot_ids" uuid[] DEFAULT '{}' NOT NULL,
	"reason" text NOT NULL,
	"severity" text DEFAULT 'HIGH' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"lots_affected" integer DEFAULT 0 NOT NULL,
	"units_on_hand" integer DEFAULT 0 NOT NULL,
	"orders_affected" integer DEFAULT 0 NOT NULL,
	"customers_notified" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"order_id" uuid,
	"reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "packaged_products" ADD CONSTRAINT "packaged_products_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_allocations" ADD CONSTRAINT "product_allocations_lot_id_product_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."product_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packaged_products_org_idx" ON "packaged_products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "packaged_products_review_idx" ON "packaged_products" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "packaged_products_gtin_idx" ON "packaged_products" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX "product_allocations_order_idx" ON "product_allocations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "product_allocations_line_idx" ON "product_allocations" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "product_allocations_lot_idx" ON "product_allocations" USING btree ("lot_id","status");--> statement-breakpoint
CREATE INDEX "product_lots_item_loc_idx" ON "product_lots" USING btree ("menu_item_id","location_id","status");--> statement-breakpoint
CREATE INDEX "product_lots_loc_idx" ON "product_lots" USING btree ("location_id","expires_on");--> statement-breakpoint
CREATE INDEX "product_recalls_org_idx" ON "product_recalls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "product_movements_item_idx" ON "product_stock_movements" USING btree ("menu_item_id","location_id","created_at");--> statement-breakpoint
CREATE INDEX "product_movements_lot_idx" ON "product_stock_movements" USING btree ("lot_id");--> statement-breakpoint
-- Packaged goods: reserved units follow the order, whichever code path ends it.
-- CANCELED/REJECTED releases them; COLLECTED/COMPLETED/PARTIALLY_FULFILLED takes them off the shelf.
CREATE OR REPLACE FUNCTION packaged_on_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF NEW.status IN ('CANCELED', 'REJECTED') THEN k := 'RELEASE';
  ELSIF NEW.status IN ('COLLECTED', 'COMPLETED', 'PARTIALLY_FULFILLED') THEN k := 'SALE';
  ELSE RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM product_allocations WHERE order_id = NEW.id AND status = 'RESERVED') THEN RETURN NEW; END IF;
  UPDATE product_lots l SET
    reserved = l.reserved - s.q,
    on_hand = CASE WHEN k = 'SALE' THEN l.on_hand - s.q ELSE l.on_hand END,
    status = CASE WHEN k = 'SALE' AND l.on_hand - s.q = 0 AND l.status = 'ACTIVE' THEN 'DEPLETED' ELSE l.status END,
    updated_at = now()
  FROM (SELECT lot_id, sum(quantity)::int AS q FROM product_allocations WHERE order_id = NEW.id AND status = 'RESERVED' GROUP BY lot_id) s
  WHERE l.id = s.lot_id;
  INSERT INTO product_stock_movements (lot_id, menu_item_id, location_id, kind, quantity, order_id, reason)
    SELECT lot_id, menu_item_id, location_id, k, CASE WHEN k = 'SALE' THEN -sum(quantity) ELSE sum(quantity) END, NEW.id, 'Order ' || NEW.number || ' ' || lower(NEW.status::text)
    FROM product_allocations WHERE order_id = NEW.id AND status = 'RESERVED' GROUP BY lot_id, menu_item_id, location_id;
  UPDATE product_allocations SET status = CASE WHEN k = 'SALE' THEN 'SOLD' ELSE 'RELEASED' END, settled_at = now() WHERE order_id = NEW.id AND status = 'RESERVED';
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER packaged_order_status AFTER UPDATE OF status ON orders FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION packaged_on_order_status();
--> statement-breakpoint
-- A line the store could not find (UNAVAILABLE) writes its units off: they were not on the shelf.
-- A line credited or replaced before that gives its units back.
CREATE OR REPLACE FUNCTION packaged_on_line_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF NEW.status = 'UNAVAILABLE' THEN k := 'SHORT_PICK';
  ELSIF NEW.status IN ('CREDITED', 'REPLACED') THEN k := 'RELEASE';
  ELSE RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM product_allocations WHERE order_line_id = NEW.id AND status = 'RESERVED') THEN RETURN NEW; END IF;
  UPDATE product_lots l SET
    reserved = l.reserved - s.q,
    on_hand = CASE WHEN k = 'SHORT_PICK' THEN l.on_hand - s.q ELSE l.on_hand END,
    status = CASE WHEN k = 'SHORT_PICK' AND l.on_hand - s.q = 0 AND l.status = 'ACTIVE' THEN 'DEPLETED' ELSE l.status END,
    updated_at = now()
  FROM (SELECT lot_id, sum(quantity)::int AS q FROM product_allocations WHERE order_line_id = NEW.id AND status = 'RESERVED' GROUP BY lot_id) s
  WHERE l.id = s.lot_id;
  INSERT INTO product_stock_movements (lot_id, menu_item_id, location_id, kind, quantity, order_id, reason)
    SELECT lot_id, menu_item_id, location_id, k, CASE WHEN k = 'SHORT_PICK' THEN -sum(quantity) ELSE sum(quantity) END, NEW.order_id, CASE WHEN k = 'SHORT_PICK' THEN 'Not found when picking' ELSE 'Line ' || lower(NEW.status) END
    FROM product_allocations WHERE order_line_id = NEW.id AND status = 'RESERVED' GROUP BY lot_id, menu_item_id, location_id;
  UPDATE product_allocations SET status = CASE WHEN k = 'SHORT_PICK' THEN 'SHORT' ELSE 'RELEASED' END, settled_at = now() WHERE order_line_id = NEW.id AND status = 'RESERVED';
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER packaged_line_status AFTER UPDATE OF status ON order_lines FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION packaged_on_line_status();
