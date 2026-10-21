-- Additive: missing/null positions keep legacy timestamp ordering. No backfill,
-- row-version rewrite, receipt rewrite, cursor epoch or read-state reset.
ALTER TABLE flightdeck_pg_thread_pins ADD COLUMN IF NOT EXISTS order_position INTEGER CHECK(order_position >= 0);
